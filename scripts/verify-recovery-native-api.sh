#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

CLUSTER_NAME="raibit-recovery-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"
KIND_NODE_IMAGE="kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
CONTROL_NAMESPACE="raibitserver-system"
TENANT_NAMESPACE="project-1"
RELEASE_NAME="nat"
FULLNAME="${RELEASE_NAME}-raibitserver"
PROVISIONER_USER="system:serviceaccount:${CONTROL_NAMESPACE}:${FULLNAME}-provisioner"
EVIDENCE_DIR="${RAIBITSERVER_RECOVERY_NATIVE_EVIDENCE_DIR:-${ROOT_DIR}/.omo/evidence/pr17-review-followup/p2-native-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}}"
WORK_DIR=""
CLUSTER_JOURNALED=0

mkdir -p "${EVIDENCE_DIR}"
exec > >(tee "${EVIDENCE_DIR}/run.log") 2>&1

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  cleanup_status=0
  if [[ "${CLUSTER_JOURNALED}" -eq 1 ]]; then
    timeout 120s kind delete cluster --name "${CLUSTER_NAME}" || cleanup_status=$?
  fi
  if [[ -n "${WORK_DIR}" ]]; then
    rm -rf -- "${WORK_DIR:?}"
  fi
  printf 'scenario_exit=%d\ncleanup_exit=%d\ncluster=%s\nfixture_interpretation=synthetic terminal Job with a non-controller blocking dependent Pod; not backup success\n' \
    "${status}" "${cleanup_status}" "${CLUSTER_NAME}" >"${EVIDENCE_DIR}/cleanup-receipt.txt"
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status=${cleanup_status}
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command in go helm jq kind kubectl timeout; do
  command -v "${command}" >/dev/null || { echo "required command is unavailable: ${command}" >&2; exit 1; }
done

if kind get clusters 2>/dev/null | grep -Fxq "${CLUSTER_NAME}"; then
  echo "refusing to reuse cluster: ${CLUSTER_NAME}" >&2
  exit 1
fi

cat >"${EVIDENCE_DIR}/resource-journal.txt" <<EOF
cluster=${CLUSTER_NAME}; cleanup=kind delete cluster --name ${CLUSTER_NAME}
context=${KUBE_CONTEXT}; ownership=created-by-this-script
namespaces=${CONTROL_NAMESPACE},${TENANT_NAMESPACE}; cleanup=owned-cluster-deletion
release=${RELEASE_NAME}; scope=worker-security-template-only; cleanup=owned-cluster-deletion
work_dir=mktemp-created-after-this-journal; cleanup=owned-script-exit-trap
EOF
WORK_DIR="$(mktemp -d)"
CLUSTER_JOURNALED=1

timeout 240s kind create cluster --name "${CLUSTER_NAME}" --image "${KIND_NODE_IMAGE}" --wait 180s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s version -o json >"${EVIDENCE_DIR}/kubernetes-version.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s create namespace "${CONTROL_NAMESPACE}"

timeout 60s helm template "${RELEASE_NAME}" infra/helm/raibitserver \
  --namespace "${CONTROL_NAMESPACE}" --show-only templates/worker-security.yaml >"${EVIDENCE_DIR}/worker-security.yaml"
test "$(grep -Fc 'oldObject.spec.ttlSecondsAfterFinished == 600' "${EVIDENCE_DIR}/worker-security.yaml")" -eq 1
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s apply -f "${EVIDENCE_DIR}/worker-security.yaml"

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s create namespace "${TENANT_NAMESPACE}"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s label namespace "${TENANT_NAMESPACE}" \
  kubernetes.io/metadata.name="${TENANT_NAMESPACE}" \
  app.kubernetes.io/managed-by=raibitserver raibitserver.io/managed=true \
  raibitserver.io/namespace-kind=application raibitserver.io/project=demo \
  raibitserver.io/project-id=project-1 pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/audit=restricted pod-security.kubernetes.io/warn=restricted --overwrite

cat >"${WORK_DIR}/tenant-rolebinding.yaml" <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${FULLNAME}-provisioner-tenant-access
  namespace: ${TENANT_NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${FULLNAME}-provisioner-tenant
subjects:
  - kind: ServiceAccount
    name: ${FULLNAME}-provisioner
    namespace: ${CONTROL_NAMESPACE}
EOF
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s apply -f "${WORK_DIR}/tenant-rolebinding.yaml"

timeout 120s bash -c "cd services/provisioner && exec go test ./internal/backup -run '^Test_RecoveryNetworkPolicyManifest_emits_admission_fixture$' -count=1 -v" >"${EVIDENCE_DIR}/generated-go.log"
sed -n 's/^.*BOUNDARY_FIXTURE=//p' "${EVIDENCE_DIR}/generated-go.log" >"${EVIDENCE_DIR}/generated-recovery.json"
test -s "${EVIDENCE_DIR}/generated-recovery.json"
jq -e 'type == "object" and (.policy | type == "object") and (.job | type == "object")' \
  "${EVIDENCE_DIR}/generated-recovery.json" >/dev/null
jq '.policy' "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/generated-networkpolicy.json"

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" \
  create -f "${EVIDENCE_DIR}/generated-networkpolicy.json"
policy_name="$(jq -r '.metadata.name' "${EVIDENCE_DIR}/generated-networkpolicy.json")"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get networkpolicy "${policy_name}" -o json >"${EVIDENCE_DIR}/stored-networkpolicy.json"
test "$(jq -r 'if .spec | has("ingress") then "present" else "omitted" end' "${EVIDENCE_DIR}/stored-networkpolicy.json")" = omitted

jq '.metadata.name = "recovery-egress-bbbbbbbbbbbbbbbbbbbbbbbb" | .spec.ingress = [{}]' \
  "${EVIDENCE_DIR}/generated-networkpolicy.json" >"${WORK_DIR}/nonempty-ingress.json"
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" \
  create -f "${WORK_DIR}/nonempty-ingress.json" >"${EVIDENCE_DIR}/nonempty-ingress.stdout" 2>"${EVIDENCE_DIR}/nonempty-ingress.stderr"; then
  echo "nonempty recovery ingress unexpectedly admitted" >&2
  exit 1
fi
grep -F "${FULLNAME}-provisioner-recovery-networkpolicies" "${EVIDENCE_DIR}/nonempty-ingress.stderr"

jq '.job | .spec.suspend = true' \
  "${EVIDENCE_DIR}/generated-recovery.json" >"${EVIDENCE_DIR}/native-ttl-job.json"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --as "${PROVISIONER_USER}" \
  create -f "${EVIDENCE_DIR}/native-ttl-job.json"
job_name="$(jq -r '.metadata.name' "${EVIDENCE_DIR}/native-ttl-job.json")"
job_uid="$(kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get job "${job_name}" -o jsonpath='{.metadata.uid}')"
cat >"${WORK_DIR}/dependent-pod.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: native-ttl-dependent
  namespace: ${TENANT_NAMESPACE}
  ownerReferences:
    - apiVersion: batch/v1
      kind: Job
      name: ${job_name}
      uid: ${job_uid}
      blockOwnerDeletion: true
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: dependent
      image: registry.k8s.io/pause:3.10
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
EOF
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s apply -f "${WORK_DIR}/dependent-pod.yaml"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get pod native-ttl-dependent -o json >"${EVIDENCE_DIR}/dependent-pod.json"
test "$(jq -r '.metadata.ownerReferences[0].uid' "${EVIDENCE_DIR}/dependent-pod.json")" = "${job_uid}"

started_at="$(date -u -d '12 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
finished_at="$(date -u -d '11 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pod native-ttl-dependent -o json >"${EVIDENCE_DIR}/pre-ttl-dependent-pod.json"
jq -e --arg uid "${job_uid}" '
  .metadata.ownerReferences[0].uid == $uid and
  .metadata.ownerReferences[0].blockOwnerDeletion == true and
  (.metadata.ownerReferences[0] | has("controller") | not) and
  (.metadata | has("deletionTimestamp")) == false
' "${EVIDENCE_DIR}/pre-ttl-dependent-pod.json" >/dev/null
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" patch job "${job_name}" \
  --subresource=status --type=merge -p "{\"status\":{\"startTime\":\"${started_at}\",\"completionTime\":\"${finished_at}\",\"succeeded\":1,\"conditions\":[{\"type\":\"SuccessCriteriaMet\",\"status\":\"True\",\"lastTransitionTime\":\"${finished_at}\",\"reason\":\"NativeTTLProbe\"},{\"type\":\"Complete\",\"status\":\"True\",\"lastTransitionTime\":\"${finished_at}\",\"reason\":\"NativeTTLProbe\"}]}}"
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" get job "${job_name}" -o json >"${EVIDENCE_DIR}/terminal-job.json"
jq -e --arg started "${started_at}" --arg finished "${finished_at}" '
  .status.startTime == $started and .status.completionTime == $finished and .status.succeeded == 1 and
  (.status.conditions | any(.type == "SuccessCriteriaMet" and .status == "True")) and
  (.status.conditions | any(.type == "Complete" and .status == "True"))
' "${EVIDENCE_DIR}/terminal-job.json" >/dev/null

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace kube-system get pod \
  --selector component=kube-controller-manager -o json >"${EVIDENCE_DIR}/controller-manager.json"
if jq -e '.items[0].spec.containers[0].command | any(. == "--use-service-account-credentials=true")' "${EVIDENCE_DIR}/controller-manager.json" >/dev/null; then
  controller_identity='system:serviceaccount:kube-system:ttl-after-finished-controller'
  garbage_collector_identity='system:serviceaccount:kube-system:generic-garbage-collector'
else
  controller_identity='system:kube-controller-manager'
  garbage_collector_identity='system:kube-controller-manager'
fi
printf 'controller_identity=%s\ngarbage_collector_identity=%s\njob_uid=%s\ndependent_pre_ttl_exists=true\ndependent_owner_reference_controller=false\nterminal_fixture=synthetic SuccessCriteriaMet+Complete conditions with startTime 12 minutes and completionTime 11 minutes before submission\nproof_interpretation=dependent Pod existed without deletionTimestamp immediately before terminal status; subsequent absence requires native foreground GC, not Job-controller cleanup\nttl_seconds=600\n' \
  "${controller_identity}" "${garbage_collector_identity}" "${job_uid}" >"${EVIDENCE_DIR}/native-delete-observation.txt"

kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=delete "job/${job_name}" --timeout=120s
kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  wait --for=delete pod/native-ttl-dependent --timeout=120s
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get job "${job_name}" >"${EVIDENCE_DIR}/post-ttl-job.stdout" 2>"${EVIDENCE_DIR}/post-ttl-job.stderr"; then
  echo "TTL wait returned but recovery Job still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/post-ttl-job.stderr"
if kubectl --context "${KUBE_CONTEXT}" --request-timeout=30s --namespace "${TENANT_NAMESPACE}" \
  get pod native-ttl-dependent >"${EVIDENCE_DIR}/post-ttl-pod.stdout" 2>"${EVIDENCE_DIR}/post-ttl-pod.stderr"; then
  echo "foreground GC wait returned but dependent Pod still exists" >&2
  exit 1
fi
grep -E 'NotFound|not found' "${EVIDENCE_DIR}/post-ttl-pod.stderr"
printf 'NETWORKPOLICY_OMITTED_INGRESS=PASS\nNONEMPTY_INGRESS_DENIED=PASS\nNATIVE_TTL_DELETE=PASS\nFOREGROUND_POD_GC=PASS\n'
