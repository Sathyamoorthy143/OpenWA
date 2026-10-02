// The env loader MUST be the first import: it populates process.env from .env / data/.env.generated
// before any other module is evaluated, so modules that read process.env at import time (e.g. the
// webhook Worker's @Processor connection) see the configured values rather than pre-dotenv defaults.
import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ShutdownSignal } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule, DASHBOARD_DIST, dashboardServingEnabled, dashboardBuildPresent } from './app.module';
import { ShutdownService } from './common/services/shutdown.service';
import { LoggerService, LogLevel, createLogger } from './common/services/logger.service';
import {
  createSwaggerConfig,
  documentErrorResponses,
  dropUnexpressibleOperations,
  exemptPublicOperations,
} from './config/swagger.config';
import { registerUncaughtExceptionMonitor, registerUnhandledRejectionHandler } from './config/process-error-monitor';
import { runBootstrapOrExit } from './config/bootstrap-fatal';
import { validateEnv } from './config/env.validation';
import { resolveStorageRoot } from './config/storage-root';
import { applyHttpTimeouts, HttpTimeoutConfig, HttpTimeoutSink } from './config/http-timeouts';
import { applyGlobalValidation } from './config/app-validation';
import { configureApp } from './configure-app';
import {
  isSwaggerEnabled,
  isDashboardCspUpgradeTrapLikely,
  assertNoDefaultSecretsInProduction,
  isApiKeyPepperMissingInProduction,
  isMainDbSynchronizeInProduction,
  isNodeEnvUnset,
} from './config/bootstrap-security';
import { BullBoardAuthMiddleware } from './common/security/bull-board-auth.middleware';
import { invalidTrustedProxies } from './common/utils/ip';
import { AuthService } from './modules/auth/auth.service';
import { AuditService } from './modules/audit/audit.service';
import { Request, Response, NextFunction } from 'express';
import { RedisIoAdapter } from './modules/events/redis-io.adapter';
import { prestartBuiltinDatabase } from './modules/docker/docker.service';

// The created app, exposed at module scope so the fatal handler below can run a best-effort teardown
// (engine sessions, Redis/pg) when bootstrap fails AFTER NestFactory.create succeeded — notably a
// listen() bind failure (EADDRINUSE), where full init already ran.
let appInstance: INestApplication | undefined;

async function bootstrap() {
  // Apply the operator-configured log verbosity (LOG_LEVEL) before anything logs. Unset means INFO.
  // A misspelling is skipped here; validateEnv below rejects it before the boot has any side effect.
  const requestedLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (requestedLevel && (Object.values(LogLevel) as string[]).includes(requestedLevel)) {
    LoggerService.setLogLevel(requestedLevel as LogLevel);
  }

  // Backstop for promise rejections that escaped a local handler (e.g. a fire-and-forget engine-event
  // dispatch), including the expected engine-teardown case it downgrades to a warning (see the helper).
  const bootstrapLogger = createLogger('Bootstrap');
  registerUnhandledRejectionHandler(bootstrapLogger);

  // A synchronous throw from a non-promise context (e.g. a sync timer callback) is fatal — Node prints a
  // raw stack to stderr, bypassing the structured log pipeline, and exits(1). Route the stack through the
  // logger WITHOUT swallowing the exception, so the crash-and-restart posture is unchanged (see the helper).
  registerUncaughtExceptionMonitor(bootstrapLogger);

  // Validate the environment before anything acts on it. ConfigModule.forRoot runs the same check, but
  // only once NestFactory.create awaits it, which is after the storage root is created and a built-in
  // PostgreSQL container is started; an invalid config would do both and then be reported twice.
  validateEnv(process.env);

  // Advisory (not enforced): an unset/blank NODE_ENV is the deliberate local-dev default, but it
  // silently degrades four controls to their dev posture (the default-secret guard, wildcard CORS,
  // Swagger UI, validation error detail) — warn so a production deployment that simply forgot the
  // variable can tell. The defaults themselves stay unchanged.
  if (isNodeEnvUnset(process.env.NODE_ENV)) {
    bootstrapLogger.warn(
      'NODE_ENV is not set: running with development defaults — the default-secret guard is skipped, ' +
        'wildcard CORS is allowed, Swagger UI is served, and validation error detail is exposed. ' +
        'Set NODE_ENV=production for a production deployment.',
    );
  }

  // Fail fast: never start production with default/placeholder secrets.
  assertNoDefaultSecretsInProduction({
    nodeEnv: process.env.NODE_ENV,
    databaseType: process.env.DATABASE_TYPE,
    databasePassword: process.env.DATABASE_PASSWORD,
    postgresBuiltIn: process.env.POSTGRES_BUILTIN,
    databaseHost: process.env.DATABASE_HOST,
    storageType: process.env.STORAGE_TYPE,
    minioBuiltIn: process.env.MINIO_BUILTIN,
    s3Endpoint: process.env.S3_ENDPOINT,
    // Mirror storage.service's canonical-with-legacy fallback so the guard inspects the var the app
    // actually uses (it reads S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY first).
    s3AccessKey: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY,
    s3SecretKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY,
    apiMasterKey: process.env.API_MASTER_KEY,
    allowDevApiKey: process.env.ALLOW_DEV_API_KEY,
    redisPassword: process.env.REDIS_PASSWORD,
  });

  // Advisory (not enforced): without API_KEY_PEPPER, stored API-key hashes use plain SHA-256. Enabling
  // a pepper re-hashes keys and invalidates existing ones, so we only nudge the operator (see api-key-hash.ts).
  if (isApiKeyPepperMissingInProduction(process.env.NODE_ENV, process.env.API_KEY_PEPPER)) {
    bootstrapLogger.warn(
      'API_KEY_PEPPER is not set in production: stored API-key hashes use plain SHA-256. ' +
        'Set API_KEY_PEPPER and re-issue keys to enable HMAC hashing.',
    );
  }

  // Advisory (not enforced): the main DB normally runs its migration chain; synchronize is an opt-in.
  if (isMainDbSynchronizeInProduction(process.env.NODE_ENV, process.env.MAIN_DATABASE_SYNCHRONIZE)) {
    bootstrapLogger.warn(
      'MAIN_DATABASE_SYNCHRONIZE=true in production: after its migrations the auth/audit schema is also ' +
        "synchronized to this release's entities, and those changes are not recorded in the migration ledger. " +
        'Unset it to use the main migrations alone.',
    );
  }

  // Advisory (not enforced): a TRUSTED_PROXIES entry that is not an IP or CIDR never matches, so the
  // proxy it meant to name is treated as a client. Failing the boot would break configs that run today.
  const badTrustedProxies = invalidTrustedProxies(process.env.TRUSTED_PROXIES);
  if (badTrustedProxies.length > 0) {
    bootstrapLogger.warn(
      `TRUSTED_PROXIES entries that are not an IP address or CIDR range are ignored: ${badTrustedProxies.join(', ')}`,
    );
  }

  // Fail fast on a media storage root the app cannot write to, BEFORE Nest builds the module graph:
  // StorageService only checks that the root EXISTS, so a root owned by another user passes boot and
  // fails later on the first media write instead (#1065). Runs ahead of NestFactory.create so
  // configuration.ts reads the resolved value.
  process.env.STORAGE_LOCAL_PATH = resolveStorageRoot({
    configured: process.env.STORAGE_LOCAL_PATH,
    logger: bootstrapLogger,
  });

  // The data connection dials PostgreSQL inside NestFactory.create, so a stopped built-in container
  // must be started before it, not from DockerService.onModuleInit (see the helper).
  await prestartBuiltinDatabase();

  // Disable Nest's default body parser so we can set an explicit size cap below. Framework lines
  // (route mapping, unhandled-exception stacks) go through the app logger so LOG_LEVEL, LOG_FORMAT and
  // the request id apply to them too.
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: createLogger('Nest') });
  appInstance = app;

  // Cross-replica WebSocket fan-out: when Redis is enabled, broadcasts reach clients on every
  // replica, not just this process. Set before the gateway's namespace is created so it inherits
  // the adapter. Inert (plain in-memory adapter) without REDIS_ENABLED, so single-node pays nothing.
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  // The production HTTP surface: request context, the CSP nonce, helmet, the SPA document handler,
  // CORS, in-flight body budget, body parsers and the trailing-slash DELETE refusal. Extracted so the
  // e2e lane runs the SAME stack instead of a copy of it (src/configure-app.ts).
  const { bodyLimit, inflightBudgetBytes } = configureApp(app);
  bootstrapLogger.log(`Request body caps: ${bodyLimit} per request, ${inflightBudgetBytes} bytes aggregate in flight`);

  // Let Nest own every shutdown signal EXCEPT SIGTERM/SIGINT — those we route through the bounded
  // drain below, so a load balancer / orchestrator observes readiness=503 and stops routing BEFORE
  // teardown begins. (enableShutdownHooks with an EMPTY array registers ALL signals; this filtered
  // list is non-empty, so the exclusion is honoured.)
  app.enableShutdownHooks(
    Object.values(ShutdownSignal).filter(s => s !== ShutdownSignal.SIGTERM && s !== ShutdownSignal.SIGINT),
  );

  // Wire up graceful shutdown service
  const shutdownService = app.get(ShutdownService);
  shutdownService.setShutdownCallback(async () => {
    await app.close();
  });

  // On SIGTERM/SIGINT: drain gracefully. shutdown() flips readiness to 503 immediately (the LB stops
  // routing), keeps serving in-flight requests for a bounded grace, then runs app.close() (the SAME
