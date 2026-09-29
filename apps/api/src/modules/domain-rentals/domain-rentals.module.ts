import { Body, Controller, Get, HttpCode, HttpException, Injectable, Module, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveControlPlaneRepositoryConfig } from '@raibitserver/core';
import { DomainRentalError, DomainRentals, MemoryDomainRentalRepository } from '@raibitserver/core/domain-rentals';
import { createPostgresDomainRentalRepository, type PostgresDomainRentalRepository } from '@raibitserver/core/domain-rentals-postgres';
import { handleDomainRentalRedirect } from '@raibitserver/core/domain-rentals-http';
import { RequirePermission } from '../../auth/permissions.decorator';
import { ControlPlaneModule } from '../../control-plane.module';
import { RAIBITSERVERService } from '../../raibitserver.service';

type RentalRequest = { raibitSubject: { id?: unknown } };

@Injectable()
export class DomainRentalsService implements OnModuleDestroy {
  private readonly engine: Promise<DomainRentals>;
  private postgres?: PostgresDomainRentalRepository;
  constructor(controlPlane: RAIBITSERVERService) {
    this.engine = resolveControlPlaneRepositoryConfig().kind === 'prisma'
      ? createPostgresDomainRentalRepository().then((repository) => {
        this.postgres = repository;
        return new DomainRentals(repository);
      })
      : Promise.resolve(new DomainRentals(new MemoryDomainRentalRepository(async (id) => {
        const { user } = await controlPlane.currentUser({ id });
        return user;
      })));
  }
  async onModuleDestroy() { await this.engine.catch(() => undefined); await this.postgres?.disconnect(); }
  async redirect(request: IncomingMessage, response: ServerResponse) {
    return handleDomainRentalRedirect(await this.engine, request, response);
  }
  async run(operation: (engine: DomainRentals) => Promise<unknown>) {
    try { return await operation(await this.engine); }
    catch (error) {
      if (error instanceof DomainRentalError) throw new HttpException({ error: error.code, message: error.code }, error.statusCode);
      throw error;
    }
  }
}

// Personal account capability, not an organization/project write permission.
// The core always loads the current User and enforces ownership itself.
@RequirePermission('project:read')
@Controller('domain-rentals')
export class DomainRentalsController {
  constructor(private readonly rentals: DomainRentalsService) {}
  @Get()
  list(@Req() req: RentalRequest) { return this.rentals.run((engine) => engine.list(owner(req))); }
  @Post()
  create(@Req() req: RentalRequest, @Body() body: unknown) { return this.rentals.run((engine) => engine.create(owner(req), body)); }
  @Post(':id/update')
  @HttpCode(200)
  update(@Req() req: RentalRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentals.run((engine) => engine.update(owner(req), id, body));
  }
  @Post(':id/delete')
  @HttpCode(200)
  remove(@Req() req: RentalRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentals.run(async (engine) => { await engine.remove(owner(req), id, body); return { ok: true }; });
  }
}
function owner(req: RentalRequest): string {
  const id = req.raibitSubject?.id;
  if (typeof id !== 'string' || !id) throw new UnauthorizedException();
  return id;
}

@Module({ imports: [ControlPlaneModule], controllers: [DomainRentalsController], providers: [DomainRentalsService], exports: [DomainRentalsService] })
export class DomainRentalsModule {}
