# Proxym Tracking Backend - Docker Guide

## Project Structure
Make sure these files are in your project root:
```
trackingbackend/
├── Dockerfile
├── docker-compose.yml
├── .env
├── .dockerignore
├── server.js
├── package.json
└── ...
```

---

## 1. First Time Setup

Copy your `.env` file to the project root and fill in your passwords:
```bash
# Make sure .env is in the root folder alongside docker-compose.yml
```

---

## 2. Build & Start Everything

```bash
# Build the image and start all containers
docker-compose up --build -d
```

- `--build` → forces Docker to rebuild the image
- `-d` → runs in background (detached mode)

---

## 3. Check Everything Is Running

```bash
docker-compose ps
```

You should see all 4 containers with status `Up`:
- `proxym_backend`
- `proxym_mysql`
- `proxym_redis`
- `proxym_phpmyadmin`

---

## 4. View Logs

```bash
# All containers
docker-compose logs -f

# Just the backend
docker-compose logs -f backend

# Just MySQL
docker-compose logs -f mysql
```

---

## 5. Stop Everything

```bash
docker-compose down
```

---

## 6. Stop & Delete All Data (fresh start)

```bash
# WARNING: This deletes your MySQL and Redis data
docker-compose down -v
```

---

## 7. Restart a Single Container

```bash
docker-compose restart backend
```

---

## 8. Rebuild After Code Changes

```bash
docker-compose up --build -d backend
```

---

## 9. Access Your Services

| Service      | URL                        |
|--------------|----------------------------|
| Backend API  | http://localhost:5000       |
| phpMyAdmin   | http://localhost:8080       |
| MySQL        | localhost:3306              |
| Redis        | localhost:6379              |

---

## 10. Go Inside a Container (for debugging)

```bash
# Go inside the backend container
docker exec -it proxym_backend sh

# Go inside MySQL container
docker exec -it proxym_mysql bash

# Run MySQL CLI directly
docker exec -it proxym_mysql mysql -u root -p
```

---

## 11. Common Problems & Fixes

**Backend starts before MySQL is ready:**
Already handled — `depends_on` with `healthcheck` ensures MySQL is healthy first.

**Port already in use:**
```bash
# Check what's using port 5000
netstat -ano | findstr :5000   # Windows
lsof -i :5000                  # Mac/Linux
```

**Container keeps restarting:**
```bash
docker-compose logs backend
```
Check the logs to see the error.

**Fresh rebuild from scratch:**
```bash
docker-compose down -v
docker-compose up --build -d
```