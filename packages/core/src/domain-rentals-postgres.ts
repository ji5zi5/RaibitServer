import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainRentalError, type DomainRental, type DomainRentalAudit, type DomainRentalRepository, type DomainRentalTransaction } from './domain-rentals.ts';

type Row = Omit<DomainRental, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };
const view = (row: Row | null): DomainRental | null => row && ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

class PostgresRentalTransaction implements DomainRentalTransaction {
  readonly client: Prisma.TransactionClient;
  constructor(client: Prisma.TransactionClient) { this.client = client; }
  async user(id: string) {
    return this.client.user.findUnique({ where: { id }, select: {
      id: true, accountType: true, approvalStatus: true, bannedAt: true, banExpiresAt: true,
    } });
  }
  async list(ownerUserId: string) {
    const rows = await this.client.domainRental.findMany({ where: { ownerUserId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => view(row)!);
  }
  async find(id: string) { return view(await this.client.domainRental.findUnique({ where: { id } })); }
  async findHostname(hostname: string) { return view(await this.client.domainRental.findUnique({ where: { hostname } })); }
  async occupied(hostname: string) {
    return Boolean(await this.client.domain.findFirst({ where: { domain: { equals: hostname, mode: 'insensitive' } }, select: { id: true } }));
  }
  async insert(rental: DomainRental) {
    await this.client.domainRental.create({ data: { ...rental, createdAt: new Date(rental.createdAt), updatedAt: new Date(rental.updatedAt) } });
  }
  async update(rental: DomainRental) {
    // Ownership and version are also predicates at the write boundary.
    const result = await this.client.domainRental.updateMany({
      where: { id: rental.id, ownerUserId: rental.ownerUserId, version: rental.version - 1 },
      data: { hostname: rental.hostname, targetUrl: rental.targetUrl, enabled: rental.enabled,
        version: rental.version, updatedAt: new Date(rental.updatedAt) },
    });
    if (result.count !== 1) throw new DomainRentalError('DOMAIN_RENTAL_VERSION_CONFLICT', 409);
  }
  async remove(id: string) { await this.client.domainRental.delete({ where: { id } }); }
  async audit(event: DomainRentalAudit) {
    await this.client.auditLog.create({ data: { actorUserId: event.actorUserId, action: event.action,
      targetType: 'DomainRental', targetId: event.rental.id,
      // Target URLs can contain private query tokens: do not copy them to logs.
      metadata: { hostname: event.rental.hostname, version: event.rental.version, enabled: event.rental.enabled },
    } });
  }
}

export class PostgresDomainRentalRepository extends PostgresRentalTransaction implements DomainRentalRepository {
  readonly prisma: PrismaClient;
  constructor(prisma: PrismaClient) { super(prisma); this.prisma = prisma; }
  async withOwner<T>(ownerUserId: string, work: (tx: DomainRentalTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The same User row is updated by approval/type changes. Acquire its
        // lock BEFORE reading the authoritative quota and counting rentals.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerUserId} FOR UPDATE`;
        return work(new PostgresRentalTransaction(tx));
      }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });
    } catch (error) {
      const e = error as { code?: string; meta?: { code?: string } };
      if (e.code === 'P2002' || (e.code === 'P2010' && e.meta?.code === '23505')) {
        throw new DomainRentalError('DOMAIN_RENTAL_NAME_TAKEN', 409);
      }
      throw error;
    }
  }
  async disconnect() { await this.prisma.$disconnect(); }
}

export async function createPostgresDomainRentalRepository() {
  const { PrismaClient } = await import('@prisma/client');
  return new PostgresDomainRentalRepository(new PrismaClient());
}
