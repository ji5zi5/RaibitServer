import { z } from 'zod';

// Transport shapes match the account-scoped rental API. The core additionally
// checks reserved names, public destinations, account eligibility and ownership.
const name = z.string().min(1).max(63);
const targetUrl = z.string().min(1).max(4096);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const DomainRentalSchema = z.object({
  id: z.string().min(1), ownerUserId: z.string().min(1), hostname: z.string().min(1),
  targetUrl, enabled: z.boolean(), version,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const DomainRentalListSchema = z.object({
  baseDomain: z.string().min(1), nameMaxLength: z.literal(63), targetMaxLength: z.literal(4096),
  accountType: z.enum(['CLUB_MEMBER', 'NON_CLUB']), limit: z.union([z.literal(2), z.literal(5)]),
  used: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(),
  rentals: z.array(DomainRentalSchema.extend({ name, url: z.url(), quotaSuspended: z.boolean() })),
}).strict();
export const DomainRentalCreateSchema = z.object({ name, targetUrl, enabled: z.boolean().optional() }).strict();
export const DomainRentalUpdateSchema = z.object({
  name: name.optional(), targetUrl: targetUrl.optional(), enabled: z.boolean().optional(), expectedVersion: version,
}).strict().refine((value) => value.name !== undefined || value.targetUrl !== undefined || value.enabled !== undefined,
  'At least one change is required');
export const DomainRentalDeleteSchema = z.object({ expectedVersion: version }).strict();
export const DomainRentalDeletedSchema = z.object({ ok: z.literal(true) }).strict();
