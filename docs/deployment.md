# Deployment Guide

## Option A: Railway (Recommended for Portfolio)

Railway provides PostgreSQL + Redis + Node.js deployment in one dashboard.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create a new project
railway new

# Add PostgreSQL service
railway add --service postgresql

# Add Redis service
railway add --service redis

# Deploy the backend
railway up

# Set environment variables
railway variables set GEMINI_API_KEY=AIza...
railway variables set JWT_SECRET=$(openssl rand -hex 32)
railway variables set JWT_REFRESH_SECRET=$(openssl rand -hex 32)
railway variables set NODE_ENV=production
```

**After deployment:**
1. Enable pgvector: `railway connect postgresql` then `CREATE EXTENSION vector;`
2. Run migrations: `railway run npx prisma migrate deploy`
3. Set the `DATABASE_URL` Railway provides automatically.

## Option B: Docker Compose (Self-hosted VPS)

```bash
# On your VPS (Ubuntu 22.04+)
git clone https://github.com/darunbjork/research-assistant-platform
cd research-assistant-platform

# Copy and fill in production .env
cp backend/.env.example backend/.env
nano backend/.env   # fill in GEMINI_API_KEY, JWT secrets

# Build and start all services
docker compose -f docker-compose.yml 
               -f docker-compose.monitoring.yml up -d --build

# Run database migrations
docker compose exec backend npx prisma migrate deploy
```

## Option C: Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Launch the app
cd backend
fly launch

# Set secrets
fly secrets set GEMINI_API_KEY=AIza...
fly secrets set JWT_SECRET=$(openssl rand -hex 32)
fly secrets set JWT_REFRESH_SECRET=$(openssl rand -hex 32)

# Deploy
fly deploy
```

## Production Environment Checklist

### Security
- [ ] `NODE_ENV=production`
- [ ] JWT secrets are 32+ random characters from `openssl rand -hex 32`
- [ ] CORS restricted to your frontend domain only
- [ ] `/metrics` endpoint firewalled from public internet
- [ ] Redis protected with AUTH password
- [ ] PostgreSQL behind VPC / not publicly accessible
- [ ] TLS/HTTPS on all public endpoints
- [ ] Gemini API key restricted to your server's IP (Google Cloud Console)

### Performance
- [ ] pgvector IVFFlat index created:
  ```sql
  CREATE INDEX ON document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
  ```
- [ ] PostgreSQL connection pool sized correctly (PG_POOL_MAX=20)
- [ ] Redis connection pool sized correctly (REDIS_MAX_CONNECTIONS=10)
- [ ] Bull Queue worker concurrency set to 3 (default)

### Observability
- [ ] Prometheus scraping `/metrics` every 30s
- [ ] Grafana alerts configured with email/Slack notification
- [ ] Error logs shipped to aggregation service
- [ ] Uptime monitoring configured (UptimeRobot / Pingdom)

### Reliability
- [ ] PostgreSQL daily backups configured
- [ ] Redis persistence enabled (AOF or RDB)
- [ ] Health check endpoint `/health` connected to load balancer
- [ ] Bull Queue retry configured (MAX_ATTEMPTS=3, exponential backoff)
- [ ] Graceful shutdown handler for SIGTERM
