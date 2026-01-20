# PROXYM Tracking - Docker Deployment Guide

## 🚀 Quick Start

### 1. Prerequisites
- Docker installed
- Docker Compose installed

### 2. Setup Environment Variables

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env` file and update with your actual credentials:
- Database passwords
- JWT secret
- Firebase credentials
- API keys

### 3. Build and Start Services
```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f backend
```

### 4. Stop Services
```bash
# Stop all services
docker-compose down

# Stop and remove volumes (⚠️ deletes data)
docker-compose down -v
```

## 📋 Available Commands
```bash
# Start services
docker-compose up -d

# Stop services
docker-compose stop

# Restart services
docker-compose restart

# View logs
docker-compose logs -f

# Access MySQL
docker exec -it proxym_mysql mysql -u proxym_user -p

# Access Redis CLI
docker exec -it proxym_redis redis-cli

# Access Backend shell
docker exec -it proxym_backend sh

# Rebuild after code changes
docker-compose up -d --build
```

## 🔧 Troubleshooting

### Backend won't start
```bash
# Check logs
docker-compose logs backend

# Restart backend
docker-compose restart backend
```

### Database connection issues
```bash
# Check MySQL is running
docker-compose ps mysql

# Check MySQL logs
docker-compose logs mysql
```

### Port conflicts
If port 5000, 3306, or 6379 is already in use, edit `docker-compose.yml` and change the port mapping.

## 📊 Monitoring

### Check service status
```bash
docker-compose ps
```

### Check resource usage
```bash
docker stats
```

## 🔄 Updates

After code changes:
```bash
git pull
docker-compose up -d --build
```

## 🗄️ Database Backups

### Backup
```bash
docker exec proxym_mysql mysqldump -u proxym_user -p proxym_tracking > backup.sql
```

### Restore
```bash
docker exec -i proxym_mysql mysql -u proxym_user -p proxym_tracking < backup.sql
```

## 🌐 Production Deployment

1. Update `.env` with production credentials
2. Use strong passwords
3. Enable firewall rules
4. Set up SSL/TLS certificates
5. Configure reverse proxy (nginx)
6. Set up automated backups
7. Monitor logs and metrics

## ⚠️ Security Notes

- Never commit `.env` file to Git
- Use strong passwords for database
- Rotate JWT secrets regularly
- Keep Docker images updated
- Limit network exposure