# Screenshots

Add screenshots of your running system here for your GitHub portfolio.

## Required Screenshots

1. `grafana-overview.png` — the 12-panel dashboard with real data
2. `frontend-agent-chat.png` — agent chat with reasoning steps expanded
3. `frontend-eval-widget.png` — RAG Triad evaluation scores
4. `jaeger-trace.png` — waterfall trace of a RAG query
5. `artillery-ramp-report.png` — Artillery output during ramp-up test

## How to Take the Screenshots

```bash
# 1. Ensure all services are running
npm run dev &
npm run monitoring:up

# 2. Run seed metrics for the dashboard
npm run seed:metrics

# 3. Make a few real queries from the frontend
# Open http://localhost:5173

# 4. Take screenshots:
# - Grafana: http://localhost:3000
# - Frontend: http://localhost:5173/app
# - Jaeger: http://localhost:16686
```

Add screenshots to this directory and reference them in your README.