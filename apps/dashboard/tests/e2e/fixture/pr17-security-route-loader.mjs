import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const routeUrl = new URL('../../../app/api/control/[...path]/route.ts', import.meta.url);
const securityUrl = new URL('../../../lib/request-security.js', import.meta.url);
const require = createRequire(import.meta.url);

export async function loadSecurityRoute({ legacyMutation = false } = {}) {
  const { NextRequest } = require('next/server');
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL && decodeURI(context.parentURL) === decodeURI(routeUrl.href) && specifier === '../../../../lib/api') {
        return { url: 'data:text/javascript,export async function dashboardApiContext(){return {baseUrl:process.env.RAIBIT_PR17_API_URL,headers:{}}}', shortCircuit: true };
      }
      if (specifier === 'next/server') return next('next/server.js', context);
      if (specifier === '../../../../lib/github-oauth-relay') return next(`${specifier}.ts`, context);
      return next(specifier, context);
    },
    load(url, context, next) {
      if (decodeURI(url) === decodeURI(routeUrl.href)) return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(routeUrl, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      };
      if (legacyMutation && decodeURI(url) === decodeURI(securityUrl.href)) {
        const source = readFileSync(securityUrl, 'utf8');
        for (const suffix of ['state', 'verifier']) {
          if (!source.includes(`'__Host-raibitserver_github_oauth_${suffix}'`)) throw new Error('pr17_mutation_target_missing');
        }
        return { format: 'module', shortCircuit: true, source: source
          .replaceAll('__Host-raibitserver_github_oauth_state', 'raibitserver_github_oauth_state')
          .replaceAll('__Host-raibitserver_github_oauth_verifier', 'raibitserver_github_oauth_verifier') };
      }
      return next(url, context);
    },
  });
  try {
    return { ...(await import(routeUrl.href)), NextRequest, close: () => hooks.deregister() };
  } catch (error) { hooks.deregister(); throw error; }
}
