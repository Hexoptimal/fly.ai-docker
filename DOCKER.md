# fly.ai Docker Compose Deployment Guide

This guide explains how to deploy and manage **fly.ai** on your server using Docker Compose.

---

## 1. Quick Start

### Prerequisites
- Docker Engine (v24.0+) and Docker Compose (v2.20+)
- (Optional) NVIDIA Container Toolkit if running the connectome simulation on CUDA GPUs

### Deployment Steps
```bash
# 1. Clone or enter repository directory
cd fly.ai

# 2. Copy the environment template
cp .env.example .env

# 3. Build and launch all services in detached mode
docker compose up --build -d
```

Check the status of the containers:
```bash
docker compose ps
```

---

## 2. Services Overview & Port Map

By default, Docker Compose exposes the following services on host ports (all customizable via `.env`):

| Service | Container Name | Default Port | Description |
|---|---|---|---|
| **`web`** | `flyai-web` | `:3000` | Static web frontends (Home/Docs, 3D Simulator, Fly Radio, Fly Roulette, Flinder, Flybook React UI, Compute UI) |
| **`world-sim`** | `flyai-world-sim` | `:8082` | Always-on 3D Fruit Fly Connectome World simulation server & live SSE stream (`/live`) |
| **`flybook-api`** | `flyai-flybook-api` | `:8081` | Flybook REST API service |
| **`flybook-worker`** | `flyai-flybook-worker` | *(Internal)* | Background tick worker simulating fruit flies interacting and posting |
| **`compute-server`** | `flyai-compute` | `:8787` | Distributed compute and mining coordination API |

---

## 3. Integrating with Your Existing Host Nginx Reverse Proxy

Because you run your own host Nginx reverse proxy, you can point your existing Nginx server block directly to the exposed ports.

A ready-to-use configuration file is provided in [`nginx-reverse-proxy.conf.example`](nginx-reverse-proxy.conf.example).

### Minimal Nginx Configuration Snippet:
```nginx
upstream flyai_web {
    server 127.0.0.1:3000;
}
upstream flyai_world_sim {
    server 127.0.0.1:8082;
}
upstream flyai_flybook_api {
    server 127.0.0.1:8081;
}
upstream flyai_compute {
    server 127.0.0.1:8787;
}

server {
    listen 80;
    server_name flyai.yourdomain.com;

    # 1. Live SSE simulation stream (Disables proxy buffering for real-time events)
    location /live {
        proxy_pass http://flyai_world_sim/live;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # 2. World Simulation backend endpoints
    location /api/world/ {
        rewrite ^/api/world/(.*) /$1 break;
        proxy_pass http://flyai_world_sim;
    }

    # 3. Flybook API backend
    location /api/flybook/ {
        rewrite ^/api/flybook/(.*) /$1 break;
        proxy_pass http://flyai_flybook_api;
    }

    # 4. Compute coordinator backend
    location /api/compute/ {
        rewrite ^/api/compute/(.*) /$1 break;
        proxy_pass http://flyai_compute;
    }

    # 5. Static Web Apps & Docs
    location / {
        proxy_pass http://flyai_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 4. Frontend Route Structure

When accessing the web frontend (`:3000` or through your reverse proxy):
- `/` - Documentation & project landing page
- `/simulation/` - 3D fruit fly world simulation viewer
- `/radio/` - Fly Radio connectome audio synthesizer
- `/roulette/` - Fly Roulette connectome betting game
- `/flinder/` - Flinder fly dating match experiment
- `/flybook/` - Flybook social connectome React application
- `/compute/` - Distributed compute dashboard & jobs manager

---

---

## 5. Running the 3D Fruit Fly World Simulation

The 3D multi-fly living world simulation is the centerpiece of the project. In Docker, it is powered by two collaborating services:

```
┌─────────────────────────────────────────────────────────────┐
│                 Your Browser (:3000/simulation/)            │
│  Interactive 3D Three.js renderer & Connectome Brain Viewer │
└──────────────────────────────▲──────────────────────────────┘
                               │  SSE stream (/live)
┌──────────────────────────────┴──────────────────────────────┐
│       flyai-world-sim Container (Node.js 22 Backend)        │
│  - 24/7 Living World: flies fly, mate, lay eggs, eat & age  │
│  - Leaky integrate-and-fire connectome brain per fly        │
│  - Real-time physics, wind, odor diffusion, and threats     │
│  - Persistent checkpoint history saved to world_data volume │
└─────────────────────────────────────────────────────────────┘
```

### Starting Only the 3D World Simulation
If you only want the 3D living fly world (without the social network or compute coordinator), run:
```bash
docker compose up --build -d web world-sim
```

Open your browser and navigate to:
```
http://your-server:3000/simulation/
```
*(Or `https://flyai.yourdomain.com/simulation/` if using your host Nginx reverse proxy)*

### What is Simulated
- **Living Fly Population**: Flies fly, cast, surge on food odor plumes, groom, take off, mate, lay eggs, hatch, and age in real-time (50 simulation steps per second).
- **Live Brain Connectome**: Each fly runs the connectome spiking neural network. Sensory neurons fire based on 3D odor diffusion, antenna wind detection, and visual motion.
- **Lineage & Evolution**: Offspring inherit neural and behavioral traits from their parents.
- **Interactive UI Controls**:
  - **Orbit / Pan / Zoom**: Explore the 3D arena in Three.js.
  - **Fly Inspector**: Click on any fly to focus the camera and inspect its real-time firing neurons, sense drives, and lineage family tree.
  - **Drama Cam**: Automatically cuts to interesting fly events (courtship, egg laying, near-misses, panic flights).
  - **Stimulus Controls**: Inject vinegar odor puffs, wind gusts, or shadow threats to observe population and brain reactions.

### Customizing Simulation Settings in `.env`
You can configure the simulation parameters in your `.env` file:
```env
# Initial number of flies at startup
WORLD_START_FLIES=24

# Minimum population threshold (new immigrants arrive if population dips below this)
WORLD_MIN_FLIES=8

# Maximum carrying capacity of the arena
WORLD_MAX_FLIES=40

# Random seed for world generation
WORLD_SEED=1234

# Data persistence sink: 'files' stores history locally in the Docker volume
WORLD_SINK=files
```

---

## 6. Persistent Volumes

All stateful data is preserved in Docker named volumes:
- `flyai_world_data`: Stores simulated fly world history, population lineage, events, and checkpoints (`/app/world/world-data`).
- `flyai_fly_data`: Stores downloaded MaleCNS connectome weights (`weights.npz` and `brain.npz` in `/data`).
- `flyai_mine_data`: Stores the compute server SQLite database (`/data/mine.db`).

---

## 7. Maintenance & Management

### View Logs
```bash
# View logs from all services
docker compose logs -f

# View logs from a specific service
docker compose logs -f world-sim
docker compose logs -f flybook-worker
```

### Stop / Restart Services
```bash
# Stop all services
docker compose stop

# Restart services
docker compose restart

# Tear down containers (data volumes are kept safe)
docker compose down
```

### Updating & Rebuilding
```bash
git pull
docker compose build
docker compose up -d
```
