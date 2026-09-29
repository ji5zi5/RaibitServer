import { NestFactory } from '@nestjs/core';
import { assertApiRuntimeConfig, securityHeaders } from '@raibitserver/core';
import { AppModule } from './app.module';
import { DomainRentalsService } from './modules/domain-rentals/domain-rentals.module';

async function bootstrap() {
  const runtimeConfig = assertApiRuntimeConfig(process.env);
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use((req: any, res: any, next: any) => {
    for (const [key, value] of Object.entries(securityHeaders())) res.setHeader(key, value as string);
    next();
  });
  // The rental host must work at /, not only underneath the management /api prefix.
  const rentals = app.get(DomainRentalsService);
  app.use((req: any, res: any, next: any) => {
    void rentals.redirect(req, res).then((handled) => { if (!handled) next(); }).catch(next);
  });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  await app.listen(runtimeConfig.port);
}

void bootstrap();
