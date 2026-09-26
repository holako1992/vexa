"""token_cipher.py — AES-256-GCM at rest for the Google Calendar refresh token.

DB-30: the refresh token is a bearer credential (like the Stripe secret key, unlike the ICS feed
URL or the webhook secret, which this service has always stored PLAINTEXT-and-masked — see
``_mask_secret`` in ``main.py`` and ``git_credentials.py``'s "plaintext at rest" note in the agent
domain). Those precedents are deliberate for values that are either low-blast-radius or themselves
short-lived; a Google OAuth refresh token is neither — it is long-lived and, once presented to
Google, mints a fresh access token to the holder's calendar. It must never sit in
``users.data`` (an ordinary Postgres JSONB column, read by every admin/backup/replica path that
reads a user row) as bytes an operator with read access to the table can use directly. So it is
encrypted here before ``calendars.py`` ever puts it in a connection dict.

DB-30a: AES-256-GCM from ``cryptography`` (Apache-2.0/BSD, Category A; already vendored in this
monorepo for ``core/meetings/services/mcp``), not a hand-rolled construction.

  * ``CALENDAR_TOKEN_ENCRYPTION_KEY`` is standard base64 (``base64.b64encode`` — the padded
    alphabet, matching the generation command this module's docstring and the docs both give) of
    exactly 32 raw bytes. Any other length, or anything that fails to base64-decode, is refused —
    never silently truncated or padded, and there is never a default key.
  * a fresh random 96-bit (12-byte) nonce per encryption, from ``os.urandom`` — the size AES-GCM
    is designed for.
  * associated data = ``str(user_id).encode() + b":" + str(calendar_id).encode()``, bound at both
    encrypt and decrypt. A ciphertext copied into another user's row, or onto another calendar
    connection of the SAME user, fails AEAD verification rather than decrypting into that other
    row's context.
  * the envelope is version-prefixed (``v2:`` + standard base64 of ``nonce || ciphertext+tag``)
    so the format is self-describing. Any other prefix, including ``gcv1:``, is refused with a
    "reconnect" error: the user re-consents and a fresh ``v2:`` envelope is written.

The master key is ``CALENDAR_TOKEN_ENCRYPTION_KEY`` (config.v1, part of the ``google_calendar``
capability — see ``config.v1.json``). Unset, malformed, or the wrong length, ``encrypt``/``decrypt``
raise, and the Google OAuth routes answer their capability-gated 503 before ever reaching this
module (``_require_google_calendar`` in ``main.py``) — so a deployment with no key configured
never has a chance to write a token this module cannot read back.
"""
from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_VERSION_PREFIX = "v2:"
_LEGACY_PREFIX = "gcv1:"
_KEY_LEN = 32
_NONCE_LEN = 12  # 96 bits, the size AES-GCM is designed for


class TokenCipherError(RuntimeError):
    """The master key is missing/malformed, or a ciphertext failed to decrypt."""


def _master_key() -> bytes:
    raw = (os.environ.get("CALENDAR_TOKEN_ENCRYPTION_KEY") or "").strip()
    if not raw:
        raise TokenCipherError(
            "CALENDAR_TOKEN_ENCRYPTION_KEY is not set — refuse to encrypt or decrypt a calendar "
            "refresh token rather than store it in the clear (config.v1 capability google_calendar)"
        )
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception as e:  # noqa: BLE001 — any decode failure is the same refusal
        raise TokenCipherError(
            "CALENDAR_TOKEN_ENCRYPTION_KEY is not valid base64 — it must be standard base64 of "
            "exactly 32 raw bytes, e.g. "
            'python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"'
        ) from e
    if len(key) != _KEY_LEN:
        raise TokenCipherError(
            f"CALENDAR_TOKEN_ENCRYPTION_KEY must decode to exactly {_KEY_LEN} bytes for "
            f"AES-256-GCM, got {len(key)}"
        )
    return key


def _associated_data(user_id: object, calendar_id: object) -> bytes:
    return f"{user_id}:{calendar_id}".encode("utf-8")


def encrypt(plaintext: str, *, user_id: object, calendar_id: object) -> str:
    """A credential → an opaque, versioned, base64 blob safe to put in ``users.data``.

    ``user_id`` and ``calendar_id`` are bound as AEAD associated data — the same two values MUST
    be passed to :func:`decrypt`, or decryption fails. Never returns (or logs) the plaintext;
    raises :class:`TokenCipherError` when ``CALENDAR_TOKEN_ENCRYPTION_KEY`` is unset or malformed.
    """
    key = _master_key()
    nonce = os.urandom(_NONCE_LEN)
    aad = _associated_data(user_id, calendar_id)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), aad)
    return _VERSION_PREFIX + base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt(token: str, *, user_id: object, calendar_id: object) -> str:
    """The reverse of :func:`encrypt`. ``user_id`` and ``calendar_id`` MUST match the values
    :func:`encrypt` was called with — a mismatch (including a ciphertext copied onto another
    row) fails the same way tampering does. Raises :class:`TokenCipherError` on a missing/
    malformed key, a malformed blob, a failed AEAD check (tampering, wrong AD, or the wrong
    key), or a non-``v2:`` envelope — NEVER returns a partially-decrypted value."""
    key = _master_key()
    if token.startswith(_LEGACY_PREFIX):
        raise TokenCipherError(
            "this calendar connection's stored credential predates AES-256-GCM (DB-30a) and "
            "cannot be decrypted by this version — the user must reconnect their calendar"
        )
    if not token.startswith(_VERSION_PREFIX):
        raise TokenCipherError("not a recognized encrypted-token blob (bad version prefix)")
    try:
        blob = base64.b64decode(token[len(_VERSION_PREFIX):], validate=True)
    except Exception as e:  # noqa: BLE001 — any decode failure is the same refusal
        raise TokenCipherError(f"encrypted-token blob is not valid base64: {e}") from e
    if len(blob) < _NONCE_LEN:
        raise TokenCipherError("encrypted-token blob is too short")
    nonce, ciphertext = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
    aad = _associated_data(user_id, calendar_id)
    try:
        raw = AESGCM(key).decrypt(nonce, ciphertext, aad)
    except InvalidTag as e:
        raise TokenCipherError(
            "encrypted-token blob failed AEAD verification (tampering, wrong associated data, "
            "or the wrong key)"
        ) from e
    return raw.decode("utf-8")


def is_encrypted(value: object) -> bool:
    return isinstance(value, str) and value.startswith(_VERSION_PREFIX)
