---
key: observability
title: Logs, metrics, and traces
aliases: [observabilidade, monitoring]
related: [oncall-rotation]
tags: [operations]
confidence: 0.85
---

Services emit OpenTelemetry traces to Tempo and JSON logs to Loki. Request
rate, error, and duration dashboards live in the Grafana folder
"TW / Services". Alerts page the on-call engineer through PagerDuty.
