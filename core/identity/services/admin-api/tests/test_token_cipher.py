"""DB-30a: ``token_cipher``'s AES-256-GCM spec — round trip, tamper (ciphertext/nonce/tag), wrong
associated data (another user, another connection of the same user), wrong key, bad key
lengths/encoding, and rejection of the old ``gcv1:`` (hand-built HMAC-CTR) envelope.

Pure unit tests — no DB, no docker, no ``requires_docker`` marker, unlike
``test_google_calendar_oauth.py``'s route tests. Run with ``uv run python -m pytest
tests/test_token_cipher.py``.
"""
import base64

import pytest

from admin_api.app import token_cipher

# test-only key — valid base64 of exactly 32 raw bytes, not a real secret.
_KEY_A = base64.b64encode(b"\x11" * 32).decode()
_KEY_B = base64.b64encode(b"\x22" * 32).decode()


@pytest.fixture(autouse=True)
def _key(monkeypatch):
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", _KEY_A)
    yield


def test_round_trip():
    blob = token_cipher.encrypt("super-secret-refresh-token", user_id=1, calendar_id="cal-1")
    assert "super-secret-refresh-token" not in blob
    assert blob.startswith("v2:")
    assert token_cipher.decrypt(blob, user_id=1, calendar_id="cal-1") == "super-secret-refresh-token"
    assert token_cipher.is_encrypted(blob)
    assert not token_cipher.is_encrypted("plain-text")


def test_encrypt_and_decrypt_require_the_key(monkeypatch):
    monkeypatch.delenv("CALENDAR_TOKEN_ENCRYPTION_KEY", raising=False)
    with pytest.raises(token_cipher.TokenCipherError, match="not set"):
        token_cipher.encrypt("x", user_id=1, calendar_id="cal-1")
    with pytest.raises(token_cipher.TokenCipherError, match="not set"):
        token_cipher.decrypt("v2:whatever", user_id=1, calendar_id="cal-1")


def test_each_encryption_uses_a_fresh_nonce():
    blob1 = token_cipher.encrypt("same-plaintext", user_id=1, calendar_id="cal-1")
    blob2 = token_cipher.encrypt("same-plaintext", user_id=1, calendar_id="cal-1")
    assert blob1 != blob2  # random 96-bit nonce per call, even for identical input+AD


def test_rejects_tampered_ciphertext():
    blob = token_cipher.encrypt("refresh-token-value", user_id=1, calendar_id="cal-1")
    tampered = blob[:-2] + ("aa" if blob[-2:] != "aa" else "bb")
    with pytest.raises(token_cipher.TokenCipherError, match="AEAD"):
        token_cipher.decrypt(tampered, user_id=1, calendar_id="cal-1")


def test_rejects_tampered_nonce():
    blob = token_cipher.encrypt("refresh-token-value", user_id=1, calendar_id="cal-1")
    raw = bytearray(base64.b64decode(blob[len("v2:"):]))
    raw[0] ^= 0xFF  # flip a bit inside the nonce (the first 12 bytes)
    tampered = "v2:" + base64.b64encode(bytes(raw)).decode()
    with pytest.raises(token_cipher.TokenCipherError, match="AEAD"):
        token_cipher.decrypt(tampered, user_id=1, calendar_id="cal-1")


def test_rejects_tampered_tag():
    blob = token_cipher.encrypt("refresh-token-value", user_id=1, calendar_id="cal-1")
    raw = bytearray(base64.b64decode(blob[len("v2:"):]))
    raw[-1] ^= 0xFF  # flip a bit inside the trailing 16-byte GCM tag
    tampered = "v2:" + base64.b64encode(bytes(raw)).decode()
    with pytest.raises(token_cipher.TokenCipherError, match="AEAD"):
        token_cipher.decrypt(tampered, user_id=1, calendar_id="cal-1")


def test_rejects_truncated_blob():
    with pytest.raises(token_cipher.TokenCipherError, match="too short"):
        token_cipher.decrypt("v2:" + base64.b64encode(b"\x00" * 4).decode(),
                             user_id=1, calendar_id="cal-1")


def test_rejects_wrong_associated_data():
    blob = token_cipher.encrypt("refresh-token-value", user_id=1, calendar_id="cal-1")
    # a ciphertext copied onto another user's row
    with pytest.raises(token_cipher.TokenCipherError, match="AEAD"):
        token_cipher.decrypt(blob, user_id=2, calendar_id="cal-1")
    # a ciphertext copied onto another connection of the SAME user
    with pytest.raises(token_cipher.TokenCipherError, match="AEAD"):
        token_cipher.decrypt(blob, user_id=1, calendar_id="cal-2")
    # both correct: decrypts fine
    assert token_cipher.decrypt(blob, user_id=1, calendar_id="cal-1") == "refresh-token-value"


def test_rejects_wrong_key(monkeypatch):
    blob = token_cipher.encrypt("refresh-token-value", user_id=1, calendar_id="cal-1")
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", _KEY_B)
    with pytest.raises(token_cipher.TokenCipherError, match="AEAD"):
        token_cipher.decrypt(blob, user_id=1, calendar_id="cal-1")


@pytest.mark.parametrize("bad_key,match", [
    ("not-valid-base64-!!!", "not valid base64"),
    (base64.b64encode(b"\x11" * 31).decode(), "exactly 32"),  # one byte short
    (base64.b64encode(b"\x11" * 33).decode(), "exactly 32"),  # one byte long
])
def test_rejects_malformed_or_wrong_length_key(monkeypatch, bad_key, match):
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", bad_key)
    with pytest.raises(token_cipher.TokenCipherError, match=match):
        token_cipher.encrypt("x", user_id=1, calendar_id="cal-1")


@pytest.mark.parametrize("bad_key", ["", "   "])
def test_rejects_empty_key(monkeypatch, bad_key):
    monkeypatch.setenv("CALENDAR_TOKEN_ENCRYPTION_KEY", bad_key)
    with pytest.raises(token_cipher.TokenCipherError, match="not set"):
        token_cipher.encrypt("x", user_id=1, calendar_id="cal-1")


def test_rejects_old_hmac_ctr_envelope():
    """DB-30a replaced the hand-built HMAC-CTR construction with AES-256-GCM. Since DB-31 (the
    first caller that could ever persist a connection) ships after this module, no deployment can
    hold a ``gcv1:`` envelope — this module refuses one with a "reconnect" error instead of
    carrying legacy decrypt code for a format nothing ever wrote."""
    old_format_envelope = "gcv1:" + base64.urlsafe_b64encode(b"\x00" * 64).decode()
    with pytest.raises(token_cipher.TokenCipherError, match="reconnect"):
        token_cipher.decrypt(old_format_envelope, user_id=1, calendar_id="cal-1")


def test_rejects_unrecognized_prefix():
    with pytest.raises(token_cipher.TokenCipherError, match="bad version prefix"):
        token_cipher.decrypt("plain-value-no-prefix", user_id=1, calendar_id="cal-1")
