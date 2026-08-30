/**
 * Crypto for the file channel's config artifacts.
 *
 * Reuses the replica channel's envelope machinery verbatim — AES-GCM
 * cipher envelopes ({@link CipherEnvelope}), PBKDF2 key derivation, and
 * the shared passphrase store (OS keychain on Tauri, ephemeral on web) —
 * with ONE substitution: the salt registry. The replica channel stores
 * salts on the official server (`/sync/replica-keys`); the file channel
 * keeps them in `Readest/config/keys.json` next to the ciphertext it
 * protects, so credential sync works with no server and no account.
 *
 * Salts are not secret (they exist to foil precomputation), so a plaintext
 * keys.json on the user's own storage is the same trust level the server
 * row had. The passphrase never leaves the device.
 *
 * Behavior parity with the replica channel: when the session is locked
 * (no passphrase set / not restored), secret fields are DROPPED from the
 * push and skipped on pull — "sync without credentials", never a prompt.
 */
import { v4 as uuidv4 } from 'uuid';
import { CryptoSession } from '@/libs/crypto/session';
import type { PassphraseStore } from '@/libs/crypto/passphrase';
import { createPassphraseStore } from '@/libs/crypto/passphrase';
import { isCipherEnvelope } from '@/types/replica';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';
import type { FileSyncProvider } from './provider';
import { buildKeysPath, buildSettingsPath as buildSettingsDocPath, ancestorsOf } from './layout';
import { isSecretSlot, type RemoteKeysDoc, type SecretSlot } from './configWire';

const KEYS_SCHEMA_VERSION = 1;
const SALT_BYTES = 16;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
};

const ensureConfigDir = async (provider: FileSyncProvider): Promise<void> => {
  await provider.ensureDir(ancestorsOf(buildKeysPath(provider.rootPath)));
};

const readKeysDoc = async (provider: FileSyncProvider): Promise<RemoteKeysDoc | null> => {
  try {
    const raw = await provider.readText(buildKeysPath(provider.rootPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemoteKeysDoc;
    if (!parsed || parsed.schemaVersion !== KEYS_SCHEMA_VERSION || !Array.isArray(parsed.keys)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeKeysDoc = async (provider: FileSyncProvider, doc: RemoteKeysDoc): Promise<void> => {
  await ensureConfigDir(provider);
  await provider.writeText(buildKeysPath(provider.rootPath), JSON.stringify(doc));
};

/**
 * The file-backed stand-in for the replica key-registry client. Implements
 * exactly the three methods {@link CryptoSession} calls into. Writes union
 * by saltId against a freshly-read doc so two devices minting salts
 * concurrently keep both rows instead of orphaning one side's ciphertext.
 */
export class FileKeyRegistryClient {
  constructor(private readonly provider: FileSyncProvider) {}

  async listReplicaKeys(): Promise<ReplicaKeyRow[]> {
    const doc = await readKeysDoc(this.provider);
    // Older rows may lack createdAt (informational only) — synthesize it so
    // the session's ingest never chokes on the shape.
    return (doc?.keys ?? []).map((k) => ({ createdAt: '1970-01-01T00:00:00.000Z', ...k }));
  }

  async createReplicaKey(alg: string): Promise<ReplicaKeyRow> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const row: ReplicaKeyRow = {
      saltId: uuidv4(),
      alg,
      salt: bytesToBase64(salt),
      createdAt: new Date().toISOString(),
    };
    const doc = (await readKeysDoc(this.provider)) ?? {
      schemaVersion: KEYS_SCHEMA_VERSION,
      keys: [],
    };
    const merged = [...doc.keys.filter((k) => k.saltId !== row.saltId), row];
    await writeKeysDoc(this.provider, { schemaVersion: KEYS_SCHEMA_VERSION, keys: merged });
    return row;
  }

  async forgetReplicaKeys(): Promise<void> {
    await writeKeysDoc(this.provider, { schemaVersion: KEYS_SCHEMA_VERSION, keys: [] });
  }
}

export interface FileCryptoSession {
  session: CryptoSession;
  /** True when a passphrase is unlocked and a salt exists — fields can ship. */
  usable: boolean;
}

/**
 * Build a file-channel crypto session for one provider: shared passphrase
 * store, file-backed salts. Silently mints a salt when a stored passphrase
 * exists but the registry is empty (first file-channel use of a passphrase
 * set up for another channel).
 */
export const createFileCryptoSession = async (
  provider: FileSyncProvider,
): Promise<FileCryptoSession> => {
  const session = new CryptoSession({ client: new FileKeyRegistryClient(provider) });
  const restored = await session.tryRestoreFromStore();
  let usable = restored;
  if (!usable) {
    // No keys.json rows yet. If the shared store holds a passphrase, mint
    // our own salt so file-channel credential sync bootstraps without a
    // separate setup flow. tryRestoreFromStore already cleared a stale
    // passphrase entry when the store has one but rows couldn't load, so
    // re-reading it here is cheap and race-free enough for a UI-less path.
    const store: PassphraseStore = createPassphraseStore();
    const saved = await store.get().catch(() => null);
    if (saved) {
      try {
        await session.setup(saved);
        usable = true;
      } catch (err) {
        console.warn('[file-config] salt bootstrap failed', err);
      }
    }
  }
  return { session, usable };
};

// ── Field-level encrypt / decrypt ──────────────────────────────────────────

/** Encrypt one secret value into a wire SecretSlot; null when locked. */
export const encryptSecretValue = async (
  session: CryptoSession,
  value: unknown,
): Promise<SecretSlot | null> => {
  if (!session.isUnlocked()) return null;
  const isJson = typeof value !== 'string';
  const plaintext = isJson ? JSON.stringify(value) : (value as string);
  if (plaintext === undefined || plaintext === null) return null;
  const cipher = await session.encryptField(plaintext);
  return { $cipher: cipher, $json: isJson };
};

/** Decrypt a wire SecretSlot back to its plaintext value; null when locked. */
export const decryptSecretValue = async (
  session: CryptoSession,
  slot: unknown,
): Promise<unknown | null> => {
  if (!isSecretSlot(slot) || !isCipherEnvelope(slot.$cipher)) return null;
  if (!session.isUnlocked()) return null;
  try {
    const plaintext = await session.decryptField(slot.$cipher);
    return slot.$json ? JSON.parse(plaintext) : plaintext;
  } catch (err) {
    console.warn('[file-config] secret decrypt failed — keeping local value', err);
    return null;
  }
};

/**
 * Server-side forget parity for the file channel: drop the salt registry
 * AND scrub every SecretSlot out of the settings doc so orphaned ciphertext
 * stops circulating (the server flavor wiped envelopes across rows). Local
 * plaintext copies are untouched — the user re-enters/re-sets a passphrase
 * to start re-encrypting.
 */
export const forgetFileCrypto = async (provider: FileSyncProvider): Promise<void> => {
  await new FileKeyRegistryClient(provider).forgetReplicaKeys();
  try {
    const raw = await provider.readText(buildSettingsDocPath(provider.rootPath));
    if (!raw) return;
    const doc = JSON.parse(raw) as { fields?: Record<string, unknown> };
    if (!doc.fields) return;
    let scrubbed = false;
    for (const [path, value] of Object.entries(doc.fields)) {
      if (isSecretSlot(value)) {
        delete doc.fields[path];
        scrubbed = true;
      }
    }
    if (scrubbed)
      await provider.writeText(buildSettingsDocPath(provider.rootPath), JSON.stringify(doc));
  } catch (err) {
    console.warn('[file-config] settings scrub on forget failed', err);
  }
};
