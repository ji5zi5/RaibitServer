{{/*
The installed updater reads the NEW chart with EXISTING production values.
Resolve the default here (not in a new updater script) so the first upgrade
works even before the timer refreshes its installed libexec copy.
*/}}
{{- define "raibitserver.domainRentals.config" -}}
{{- $rentals := .Values.domainRentals | default dict -}}
{{- $mode := "auto" -}}
{{- if hasKey $rentals "enabled" -}}{{- $mode = $rentals.enabled -}}{{- end -}}
{{- if not (or (kindIs "bool" $mode) (eq (toString $mode) "auto")) -}}
{{- fail "domainRentals.enabled must be true, false, or auto" -}}
{{- end -}}
{{- $traefik := or (eq .Values.ingress.className "traefik") .Values.hostedErrors.traefik.enabled -}}
{{- $enabled := and .Values.production .Values.ingress.enabled $traefik -}}
{{- if kindIs "bool" $mode -}}{{- $enabled = and $mode .Values.ingress.enabled -}}{{- end -}}
{{- $wildcard := default (printf "*.%s" .Values.ingress.hosts.public) .Values.hostedErrors.fallbackIngress.host -}}
{{- $existingBase := trimSuffix "." (lower (trimPrefix "*." $wildcard)) -}}
{{- $base := trimSuffix "." (lower (trim (default $existingBase $rentals.baseDomain))) -}}
{{- if or (gt (len $base) 189) (not (regexMatch "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$" $base)) -}}
{{- fail "domainRentals.baseDomain must be a DNS domain of at most 189 characters" -}}
{{- end -}}
{{- if and $enabled (eq (toString $mode) "auto") (ne $base $existingBase) -}}
{{- fail "automatic domain rentals must reuse the existing wildcard base domain; use explicit enabled: true for a separately configured domain" -}}
{{- end -}}
{{- $secret := .Values.ingress.tls.existingSecret -}}
{{- if eq $base $existingBase -}}
{{- $secret = default $secret .Values.hostedErrors.fallbackIngress.tls.existingSecret -}}
{{- end -}}
{{- $secret = default $secret $rentals.tlsSecret -}}
{{- $reserved := splitList "," (default "" $rentals.reservedNames) -}}
{{- range $host := list .Values.ingress.hosts.public .Values.ingress.hosts.api .Values.ingress.hosts.dashboard -}}
{{- $host = trimSuffix "." (lower $host) -}}
{{- if hasSuffix (printf ".%s" $base) $host -}}
{{- $reserved = append $reserved (trimSuffix (printf ".%s" $base) $host) -}}
{{- end -}}
{{- end -}}
{{- $annotations := mergeOverwrite (dict) (deepCopy (.Values.ingress.annotations | default dict)) (deepCopy (.Values.hostedErrors.fallbackIngress.annotations | default dict)) (deepCopy ($rentals.annotations | default dict)) -}}
{{- $_ := set $annotations "traefik.ingress.kubernetes.io/router.priority" "2" -}}
{{- dict "enabled" $enabled "baseDomain" $base "tlsSecret" $secret "reservedNames" (join "," (uniq (compact $reserved))) "annotations" $annotations | toJson -}}
{{- end -}}
