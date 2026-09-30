import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createOpenApiDocument } from '../packages/schemas/src/api-contract.ts';

const destination = fileURLToPath(new URL('../openapi/raibitserver.yaml', import.meta.url));
const document = YAML.stringify(JSON.parse(JSON.stringify(createOpenApiDocument())), { lineWidth: 0 });
if (process.argv.includes('--check')) {
  if (JSON.stringify(YAML.parse(fs.readFileSync(destination, 'utf8'))) !== JSON.stringify(YAML.parse(document))) {
    console.error('OpenAPI differs from the current transport contracts. Run node scripts/generate-openapi.mjs.');
    process.exitCode = 1;
  }
} else fs.writeFileSync(destination, document);
