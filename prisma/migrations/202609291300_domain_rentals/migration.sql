CREATE TABLE "DomainRental" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "targetUrl" VARCHAR(4096) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DomainRental_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DomainRental_hostname_normalized" CHECK ("hostname" = lower("hostname")),
    CONSTRAINT "DomainRental_version_positive" CHECK ("version" > 0),
    CONSTRAINT "DomainRental_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DomainRental_hostname_key" ON "DomainRental"("hostname");
CREATE INDEX "DomainRental_ownerUserId_createdAt_id_idx" ON "DomainRental"("ownerUserId", "createdAt", "id");

-- Both registration paths take the same transaction-scoped hostname lock.
-- This also protects an existing custom Domain from being claimed by a rental
-- (and vice versa), even when different users submit concurrently.
CREATE FUNCTION raibit_check_rental_hostname() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(NEW."hostname"), 20260929));
  IF EXISTS (SELECT 1 FROM "Domain" WHERE lower("domain") = NEW."hostname") THEN
    RAISE EXCEPTION 'hostname is already registered' USING ERRCODE = '23505', CONSTRAINT = 'DomainRental_hostname_key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DomainRental_hostname_guard" BEFORE INSERT OR UPDATE OF "hostname" ON "DomainRental"
  FOR EACH ROW EXECUTE FUNCTION raibit_check_rental_hostname();

CREATE FUNCTION raibit_check_custom_domain_hostname() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(NEW."domain"), 20260929));
  IF EXISTS (SELECT 1 FROM "DomainRental" WHERE "hostname" = lower(NEW."domain")) THEN
    RAISE EXCEPTION 'hostname is already registered' USING ERRCODE = '23505', CONSTRAINT = 'DomainRental_hostname_key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Domain_rental_hostname_guard" BEFORE INSERT OR UPDATE OF "domain" ON "Domain"
  FOR EACH ROW EXECUTE FUNCTION raibit_check_custom_domain_hostname();
