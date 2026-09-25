"""token_cipher.py — encrypt-then-MAC at rest for the Google Calendar refresh token.

DB-30: the refresh token is a bearer credential (like the Stripe secret key, unlike the ICS feed
URL or the webhook secret, which this service has always stored PLAINTEXT-and-masked — see
``_mask_secret`` in ``main.py`` and ``git_credentials.py``'s "plaintext at rest" note in the agent
domain). Those precedents are deliberate for values that are either low-blast-radius or themselves
short-lived; a Google OAuth refresh token is neither — it is long-lived and, once presented to
Google, mints a fresh access token to the holder's calendar. It must never sit in
``users.data`` (an ordinary Postgres JSONB column, read by every admin/backup/replica path that
reads a user row) as bytes an operator with read access to the table can use directly. So it is
encrypted here before ``calendars.py`` ever puts it in a connection dict.

No AEAD library is added as a new dependency (``identity_core`` is deliberately dependency-light,
see its ``__init__.py`` docstring, and admin-api's own dependency list stays the same for this).
The construction is encrypt-then-MAC built from two stdlib primitives (``hmac``, ``hashlib``),
which is the same shape a real AEAD uses, just spelled out by hand:

  * ``key_enc = HMAC-SHA256(master_key, b"vexa-calendar-token-enc-v1")``
  * ``key_mac = HMAC-SHA256(master_key, b"vexa-calendar-token-mac-v1")``
  * a fresh random 16-byte nonce per encryption; the keystream is
    ``HMAC-SHA256(key_enc, nonce || counter)`` for counter = 0, 1, 2, ... concatenated and
    truncated to the plaintext length (HMAC-SHA256 is a secure PRF, so this is an ordinary
    counter-mode stream cipher built on it)
  * ciphertext = plaintext XOR keystream
  * tag = ``HMAC-SHA256(key_mac, nonce || ciphertext)`` (verified BEFORE decrypting — an
    encrypt-then-MAC construction, so a tampered blob is rejected without ever touching the XOR)

The master key is ``CALENDAR_TOKEN_ENCRYPTION_KEY`` (config.v1, part of the ``google_calendar``
capability — see ``config.v1.json``). Unset, ``encrypt``/``decrypt`` raise, and the Google OAuth
routes answer their capability-gated 503 before ever reaching this module (``_require_google_calendar``
in ``main.py``) — so a deployment with no key configured never has a chance to write a token this
module cannot read back.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Optional

_VERSION_PREFIX = "gcv1:"
_ENC_LABEL = b"vexa-calendar-token-enc-v1"
_MAC_LABEL = b"vexa-calendar-token-mac-v1"
_NONCE_LEN = 16
_TAG_LEN = 32
_BLOCK_LEN = 32  # one HMAC-SHA256 output


class TokenCipherError(RuntimeError):
    """The master key is missing, or a ciphertext failed integrity verification."""


def _master_key() -> bytes:
    raw = (os.environ.get("CALENDAR_TOKEN_ENCRYPTION_KEY") or "").strip()
    if not raw:
        raise TokenCipherError(
            "CALENDAR_TOKEN_ENCRYPTION_KEY is not set — refuse to encrypt or decrypt a calendar "
            "refresh token rather than store it in the clear (config.v1 capability google_calendar)"
        )
    return raw.encode("utf-8")


def _derive(master: bytes, label: bytes) -> bytes:
    return hmac.new(master, label, hashlib.sha256).digest()


def _keystream(key_enc: bytes, nonce: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(key_enc, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        out += block
        counter += 1
    return bytes(out[:length])


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def encrypt(plaintext: str) -> str:
    """A credential → an opaque, versioned, base64 blob safe to put in ``users.data``.

    Never returns (or logs) the plaintext; raises :class:`TokenCipherError` when
    ``CALENDAR_TOKEN_ENCRYPTION_KEY`` is unset."""
    master = _master_key()
    key_enc = _derive(master, _ENC_LABEL)
    key_mac = _derive(master, _MAC_LABEL)
    nonce = os.urandom(_NONCE_LEN)
    raw = plaintext.encode("utf-8")
    ciphertext = _xor(raw, _keystream(key_enc, nonce, len(raw)))
    tag = hmac.new(key_mac, nonce + ciphertext, hashlib.sha256).digest()
    blob = nonce + ciphertext + tag
    return _VERSION_PREFIX + base64.urlsafe_b64encode(blob).decode("ascii")


def decrypt(token: str) -> str:
    """The reverse of :func:`encrypt`. Raises :class:`TokenCipherError` on a missing key, a
    malformed blob, or a failed integrity check (tampering, or the wrong master key) — NEVER
    returns a partially-decrypted value."""
    master = _master_key()
    if not token.startswith(_VERSION_PREFIX):
        raise TokenCipherError("not a recognized encrypted-token blob (bad version prefix)")
    try:
        blob = base64.urlsafe_b64decode(token[len(_VERSION_PREFIX):].encode("ascii"))
    except Exception as e:  # noqa: BLE001 — any decode failure is the same refusal
        raise TokenCipherError(f"encrypted-token blob is not valid base64: {e}") from e
    if len(blob) < _NONCE_LEN + _TAG_LEN:
        raise TokenCipherError("encrypted-token blob is too short")
    nonce = blob[:_NONCE_LEN]
    ciphertext = blob[_NONCE_LEN:-_TAG_LEN]
    tag = blob[-_TAG_LEN:]
    key_enc = _derive(master, _ENC_LABEL)
    key_mac = _derive(master, _MAC_LABEL)
    expected_tag = hmac.new(key_mac, nonce + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expected_tag):
        raise TokenCipherError("encrypted-token blob failed integrity check")
    raw = _xor(ciphertext, _keystream(key_enc, nonce, len(ciphertext)))
    return raw.decode("utf-8")


def is_encrypted(value: Optional[str]) -> bool:
    return isinstance(value, str) and value.startswith(_VERSION_PREFIX)
