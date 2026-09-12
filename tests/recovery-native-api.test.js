import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync('scripts/verify-recovery-native-api.sh', 'utf8');
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const nativeJob = workflow.match(/  recovery-native-api:\n[\s\S]*?(?=\n  live-helm-e2e:)/)?.[0] ?? '';

test('native recovery API gate uses an owned bounded cluster and captures cleanup evidence', () => {
  const cleanup = script.match(/cleanup\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(script, /kind create cluster[\s\S]*--image "\$\{KIND_NODE_IMAGE\}"[\s\S]*--wait 180s/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /trap 'exit 130' INT/);
  assert.match(script, /refusing to reuse cluster/);
  assert.match(script, /timeout 120s kind delete cluster/);
  assert.doesNotMatch(cleanup, /kind get clusters/);
  assert.match(script, /resource-journal\.txt/);
  assert.match(script, /cleanup-receipt\.txt/);
  const directKubectlLines = script.split('\n').filter((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith('kubectl ') || trimmed.startsWith('if kubectl ');
  });
  assert.ok(directKubectlLines.length > 0);
  assert.equal(directKubectlLines.every((line) => line.includes('--context')), true);
  assert.match(script, /job_uid="\$\(kubectl --context/);
});

test('native recovery API gate submits generated policy and requires real TTL deletion', () => {
  assert.match(script, /BOUNDARY_FIXTURE/);
  assert.match(script, /jq -e 'type == "object"/);
  assert.match(script, /generated-networkpolicy\.json/);
  assert.match(script, /stored-networkpolicy\.json/);
  assert.match(script, /has\("ingress"\)[\s\S]*omitted/);
  assert.match(script, /nonempty recovery ingress unexpectedly admitted/);
  assert.match(script, /--subresource=status/);
  assert.match(script, /SuccessCriteriaMet/);
  assert.match(script, /startTime/);
  assert.match(script, /jq -e --arg started[\s\S]*terminal-job\.json/);
  assert.match(script, /recovery_job_policy="\$\(awk -v policy_name="\$\{FULLNAME\}-provisioner-recovery-jobs"/);
  assert.match(script, /grep -Fc 'oldObject\.spec\.ttlSecondsAfterFinished == 600' <<<"\$\{recovery_job_policy\}"\)" -ne 2/);
  assert.match(script, /request\.operation == 'DELETE' &&/);
  assert.match(script, /request\.operation != 'UPDATE' \|\|/);
  assert.match(script, /has\(oldObject\.metadata\.deletionTimestamp\)/);
  assert.match(script, /foregroundDeletion/);
  assert.match(script, /object\.spec == oldObject\.spec && object\.status == oldObject\.status/);
  assert.doesNotMatch(script, /grep -Fc 'oldObject\.spec\.ttlSecondsAfterFinished == 600' "\$\{EVIDENCE_DIR\}\/worker-security\.yaml"\)" -eq 1/);
  assert.match(script, /11 minutes ago/);
  assert.match(script, /patch job "\$\{job_name\}"[\s\S]*--subresource=status[\s\S]*-o json >"\$\{EVIDENCE_DIR\}\/terminal-job\.json"/);
  assert.doesNotMatch(script, /patch job "\$\{job_name\}"[\s\S]*?\n.*get job "\$\{job_name\}" -o json >"\$\{EVIDENCE_DIR\}\/terminal-job\.json"/);
  assert.match(script, /wait --for=delete "job\/\$\{job_name\}" --timeout=120s/);
  assert.match(script, /ownerReferences:[\s\S]*uid: \$\{job_uid\}/);
  assert.doesNotMatch(script, /controller: true/);
  assert.match(script, /pre-ttl-dependent-pod\.json/);
  assert.match(script, /has\("deletionTimestamp"\).*false/);
  assert.match(script, /wait --for=delete pod\/native-ttl-dependent --timeout=120s/);
  assert.match(script, /post-ttl-job\.stderr[\s\S]*NotFound/);
  assert.match(script, /post-ttl-pod\.stderr[\s\S]*NotFound/);
  assert.match(script, /dependent_pre_ttl_exists=true/);
  assert.doesNotMatch(script, /--dry-run/);
});

test('CI runs the focused native recovery gate and uploads its evidence', () => {
  assert.match(nativeJob, /timeout-minutes: 12/);
  assert.match(nativeJob, /verify-recovery-native-api\.sh/);
  assert.match(nativeJob, /runtime\/native-kind-v1\.34\.3-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(nativeJob, /upload-artifact@v4[\s\S]*pr17-recovery-native-api/);
  assert.doesNotMatch(nativeJob, /docker build|kind load docker-image|helm upgrade|helm install/);
});
