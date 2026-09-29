import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const DOMAIN_RENTAL_NAME_MAX_LENGTH = 63;
export const DOMAIN_RENTAL_TARGET_MAX_LENGTH = 4096;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'dashboard', 'auth', 'login', 'logout', 'sso',
  'apps', 'preview', 'console', 'resources', 'registry', 'registry-auth',
  'logs', 'metrics', 'status', 'health', 'traefik', 'grafana', 'prometheus',
  'mail', 'smtp', 'imap', 'pop', 'pop3', 'ftp', 'ssh', 'ns', 'ns1', 'ns2',
  'autoconfig', 'autodiscover', 'webmail', 'webhook', 'webhooks', 'git',
  'cdn', 'static', 'assets', 'docs', 'help', 'support', 'localhost',
]);
const RESERVED_PREFIXES = ['apps--', 'preview--', 'console--', 'resources--', 'xn--'];

type DateValue = string | Date | null;
export type DomainRentalUser = {
  id: string;
  accountType: string;
  approvalStatus: string;
  bannedAt?: DateValue;
  banExpiresAt?: DateValue;
};
export type DomainRental = {
  id: string;
  ownerUserId: string;
  hostname: string;
  targetUrl: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type DomainRentalConfig = { baseDomain: string; reservedNames: readonly string[] };
export type DomainRentalAudit = { actorUserId: string; action: string; rental: DomainRental };
export interface DomainRentalTransaction {
  user(id: string): Promise<DomainRentalUser | null>;
  list(ownerUserId: string): Promise<DomainRental[]>;
  find(id: string): Promise<DomainRental | null>;
  findHostname(hostname: string): Promise<DomainRental | null>;
  occupied(hostname: string): Promise<boolean>;
  insert(rental: DomainRental): Promise<void>;
  update(rental: DomainRental): Promise<void>;
  remove(id: string): Promise<void>;
  audit(event: DomainRentalAudit): Promise<void>;
}
export interface DomainRentalRepository extends DomainRentalTransaction {
  // Serialize mutations for this owner, including the authoritative account read.
  withOwner<T>(ownerUserId: string, work: (tx: DomainRentalTransaction) => Promise<T>): Promise<T>;
}

export class DomainRentalError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 400) {
    super(code);
    this.name = 'DomainRentalError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function domainRentalConfig(env: Record<string, string | undefined> = process.env): DomainRentalConfig {
  const baseDomain = (env.RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN || 'raibit.kr').trim().toLowerCase().replace(/\.$/, '');
  const labels = baseDomain.split('.');
  if (baseDomain.length > 189 || labels.length < 2 || labels.some((label) => !LABEL.test(label)) || isIP(baseDomain)) {
    throw new DomainRentalError('DOMAIN_RENTAL_BASE_DOMAIN_INVALID', 500);
  }
  const reservedNames = (env.RAIBITSERVER_DOMAIN_RENTAL_RESERVED_NAMES || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  for (const value of [env.RAIBITSERVER_API_URL, env.RAIBITSERVER_PUBLIC_URL, env.RAIBITSERVER_DASHBOARD_URL]) {
    if (!value) continue;
    try {
      const hostname = new URL(value).hostname;
      if (hostname.endsWith(`.${baseDomain}`)) reservedNames.push(hostname.slice(0, -baseDomain.length - 1));
    } catch { /* Other configuration validators own invalid platform URLs. */ }
  }
  return { baseDomain, reservedNames };
}

function reservedName(name: string, config: DomainRentalConfig): boolean {
  return RESERVED.has(name) || config.reservedNames.includes(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function normalizeDomainRentalName(value: unknown, config = domainRentalConfig()): string {
  if (typeof value !== 'string') throw new DomainRentalError('DOMAIN_RENTAL_NAME_INVALID');
  const name = value.trim().toLowerCase();
  if (!LABEL.test(name)) throw new DomainRentalError('DOMAIN_RENTAL_NAME_INVALID');
  if (reservedName(name, config)) throw new DomainRentalError('DOMAIN_RENTAL_NAME_RESERVED', 409);
  return name;
}

/** Only the actual Host header is used; forwarded-host headers are not trusted. */
export function domainRentalHostname(host: unknown, config = domainRentalConfig()): string | null {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) return null;
  const hostname = host.toLowerCase().replace(/:[0-9]+$/, '').replace(/\.$/, '');
  const suffix = `.${config.baseDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return LABEL.test(label) && !reservedName(label, config) ? hostname : null;
}

function localDestination(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') && !host.includes(':')) return true;
  if (['localhost', 'local', 'internal', 'lan', 'test', 'invalid'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    // Reject loopback, unspecified, link-local, ULA, multicast and IPv4-mapped IPv6.
    return host === '::' || host === '::1' || /^(?:f[cd]|fe[89ab]|ff)/.test(host) || host.startsWith('::ffff:');
  }
  return false;
}

export function normalizeDomainRentalTarget(value: unknown, config = domainRentalConfig()): string {
  if (typeof value !== 'string' || !value.trim() || value.length > DOMAIN_RENTAL_TARGET_MAX_LENGTH
    || /[\u0000-\u0020\u007f\\]/.test(value.trim()) || /%0[ad]/i.test(value)) {
    throw new DomainRentalError('DOMAIN_RENTAL_TARGET_INVALID');
  }
  let target: URL;
  try { target = new URL(value.trim()); }
  catch { throw new DomainRentalError('DOMAIN_RENTAL_TARGET_INVALID'); }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || !target.hostname || localDestination(target.hostname)) {
    throw new DomainRentalError('DOMAIN_RENTAL_TARGET_INVALID');
  }
  // Never redirect to another rentable name, including an as-yet unclaimed one.
  // This prevents both self-loops and A -> B -> A rental chains. Platform app
  // routes (apps--...), the apex and genuinely external destinations remain valid.
  if (domainRentalHostname(target.hostname, config)) throw new DomainRentalError('DOMAIN_RENTAL_REDIRECT_LOOP');
  const result = target.toString();
  if (result.length > DOMAIN_RENTAL_TARGET_MAX_LENGTH) throw new DomainRentalError('DOMAIN_RENTAL_TARGET_INVALID');
  return result;
}

export function domainRentalLimit(user: Pick<DomainRentalUser, 'accountType'>): number {
  // Administrator status and organization count never bypass this personal quota.
  return user.accountType === 'CLUB_MEMBER' ? 5 : 2;
}

export function domainRentalUserAllowed(user: DomainRentalUser | null, now = Date.now()): user is DomainRentalUser {
  if (!user || user.approvalStatus !== 'APPROVED') return false;
  return !user.bannedAt || Boolean(user.banExpiresAt && new Date(user.banExpiresAt).getTime() <= now);
}

function requireUser(user: DomainRentalUser | null): DomainRentalUser {
  if (!domainRentalUserAllowed(user)) throw new DomainRentalError('DOMAIN_RENTAL_ACCOUNT_UNAVAILABLE', 403);
  return user;
}

function inputObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainRentalError('DOMAIN_RENTAL_INPUT_INVALID');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new DomainRentalError('DOMAIN_RENTAL_INPUT_INVALID');
  return input;
}

function expectedVersion(input: Record<string, unknown>): number {
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw new DomainRentalError('DOMAIN_RENTAL_VERSION_REQUIRED');
  return Number(input.expectedVersion);
}

function sorted(rentals: DomainRental[]): DomainRental[] {
  return [...rentals].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export class DomainRentals {
  readonly repository: DomainRentalRepository;
  readonly config: DomainRentalConfig;
  constructor(repository: DomainRentalRepository, config = domainRentalConfig()) {
    this.repository = repository;
    this.config = config;
  }

  async list(ownerUserId: string) {
    const user = requireUser(await this.repository.user(ownerUserId));
    const rentals = sorted(await this.repository.list(ownerUserId));
    const limit = domainRentalLimit(user);
    return {
      baseDomain: this.config.baseDomain, nameMaxLength: DOMAIN_RENTAL_NAME_MAX_LENGTH,
      targetMaxLength: DOMAIN_RENTAL_TARGET_MAX_LENGTH, accountType: user.accountType,
      limit, used: rentals.length, remaining: Math.max(0, limit - rentals.length),
      rentals: rentals.map((rental, index) => ({ ...rental,
        name: rental.hostname.slice(0, -this.config.baseDomain.length - 1),
        url: `https://${rental.hostname}`, quotaSuspended: index >= limit,
      })),
    };
  }

  async create(ownerUserId: string, value: unknown): Promise<DomainRental> {
    const input = inputObject(value, ['name', 'targetUrl', 'enabled']);
    const name = normalizeDomainRentalName(input.name, this.config);
    const targetUrl = normalizeDomainRentalTarget(input.targetUrl, this.config);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new DomainRentalError('DOMAIN_RENTAL_INPUT_INVALID');
    return this.repository.withOwner(ownerUserId, async (tx) => {
      const user = requireUser(await tx.user(ownerUserId));
      if ((await tx.list(ownerUserId)).length >= domainRentalLimit(user)) throw new DomainRentalError('DOMAIN_RENTAL_QUOTA_EXCEEDED', 409);
      const hostname = `${name}.${this.config.baseDomain}`;
      if (await tx.findHostname(hostname) || await tx.occupied(hostname)) throw new DomainRentalError('DOMAIN_RENTAL_NAME_TAKEN', 409);
      const now = new Date().toISOString();
      const rental: DomainRental = { id: randomUUID(), ownerUserId, hostname, targetUrl,
        enabled: input.enabled !== false, version: 1, createdAt: now, updatedAt: now };
      await tx.insert(rental);
      await tx.audit({ actorUserId: ownerUserId, action: 'domain-rental.create', rental });
      return rental;
    });
  }

  async update(ownerUserId: string, id: string, value: unknown): Promise<DomainRental> {
    const input = inputObject(value, ['name', 'targetUrl', 'enabled', 'expectedVersion']);
    const version = expectedVersion(input);
    if (!['name', 'targetUrl', 'enabled'].some((key) => Object.hasOwn(input, key))) throw new DomainRentalError('DOMAIN_RENTAL_INPUT_INVALID');
    const hostname = input.name === undefined ? undefined : `${normalizeDomainRentalName(input.name, this.config)}.${this.config.baseDomain}`;
    const targetUrl = input.targetUrl === undefined ? undefined : normalizeDomainRentalTarget(input.targetUrl, this.config);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new DomainRentalError('DOMAIN_RENTAL_INPUT_INVALID');
    return this.repository.withOwner(ownerUserId, async (tx) => {
      requireUser(await tx.user(ownerUserId));
      const current = await tx.find(id);
      if (!current || current.ownerUserId !== ownerUserId) throw new DomainRentalError('DOMAIN_RENTAL_NOT_FOUND', 404);
      if (current.version !== version) throw new DomainRentalError('DOMAIN_RENTAL_VERSION_CONFLICT', 409);
      if (hostname && hostname !== current.hostname && (await tx.findHostname(hostname) || await tx.occupied(hostname))) {
        throw new DomainRentalError('DOMAIN_RENTAL_NAME_TAKEN', 409);
      }
      const rental: DomainRental = { ...current, hostname: hostname ?? current.hostname,
        targetUrl: targetUrl ?? current.targetUrl, enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
        version: current.version + 1, updatedAt: new Date().toISOString() };
      await tx.update(rental);
      await tx.audit({ actorUserId: ownerUserId, action: 'domain-rental.update', rental });
      return rental;
    });
  }

  async remove(ownerUserId: string, id: string, value: unknown): Promise<void> {
    const version = expectedVersion(inputObject(value, ['expectedVersion']));
    await this.repository.withOwner(ownerUserId, async (tx) => {
      requireUser(await tx.user(ownerUserId));
      const rental = await tx.find(id);
      if (!rental || rental.ownerUserId !== ownerUserId) throw new DomainRentalError('DOMAIN_RENTAL_NOT_FOUND', 404);
      if (rental.version !== version) throw new DomainRentalError('DOMAIN_RENTAL_VERSION_CONFLICT', 409);
      await tx.remove(id);
      await tx.audit({ actorUserId: ownerUserId, action: 'domain-rental.delete', rental });
    });
  }

  async resolve(host: unknown): Promise<string | null> {
    const hostname = domainRentalHostname(host, this.config);
    if (!hostname) return null;
    const rental = await this.repository.findHostname(hostname);
    if (!rental?.enabled) return null;
    const user = await this.repository.user(rental.ownerUserId);
    if (!domainRentalUserAllowed(user)) return null;
    // Keep records manageable after a downgrade without operating more than the
    // new limit. Deleting an older name releases a slot for the next name.
    const eligible = sorted(await this.repository.list(user.id)).slice(0, domainRentalLimit(user));
    if (!eligible.some((candidate) => candidate.id === rental.id)) return null;
    return normalizeDomainRentalTarget(rental.targetUrl, this.config);
  }
}

/** Deterministic local adapter; no second identity store is created. */
export class MemoryDomainRentalRepository implements DomainRentalRepository {
  private rows = new Map<string, DomainRental>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly events: DomainRentalAudit[] = [];
  readonly lookupUser: (id: string) => Promise<DomainRentalUser | null>;
  readonly lookupOccupied: (hostname: string) => Promise<boolean>;
  constructor(lookupUser: (id: string) => Promise<DomainRentalUser | null>, lookupOccupied = async (_hostname: string) => false) {
    this.lookupUser = lookupUser;
    this.lookupOccupied = lookupOccupied;
  }
  async user(id: string) { return this.lookupUser(id); }
  async list(ownerUserId: string) { return [...this.rows.values()].filter((row) => row.ownerUserId === ownerUserId).map((row) => ({ ...row })); }
  async find(id: string) { const row = this.rows.get(id); return row ? { ...row } : null; }
  async findHostname(hostname: string) { const row = [...this.rows.values()].find((rental) => rental.hostname === hostname); return row ? { ...row } : null; }
  async occupied(hostname: string) { return this.lookupOccupied(hostname); }
  async insert(rental: DomainRental) { if (await this.findHostname(rental.hostname)) throw new DomainRentalError('DOMAIN_RENTAL_NAME_TAKEN', 409); this.rows.set(rental.id, { ...rental }); }
  async update(rental: DomainRental) { this.rows.set(rental.id, { ...rental }); }
  async remove(id: string) { this.rows.delete(id); }
  async audit(event: DomainRentalAudit) { this.events.push(structuredClone(event)); }
  withOwner<T>(_ownerUserId: string, work: (tx: DomainRentalTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const before = new Map(this.rows);
      const auditLength = this.events.length;
      try { return await work(this); }
      catch (error) { this.rows = before; this.events.length = auditLength; throw error; }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
