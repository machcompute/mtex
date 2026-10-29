# HomeHub

Monorepo with two independent apps:

| Folder      | Stack                          | Notes                                          |
| ----------- | ------------------------------ | ---------------------------------------------- |
| `backend/`  | Go 1.26, stdlib `net/http`     | REST API, runs on `:8080` (override with `PORT`) |
| `frontend/` | Next.js (App Router), TypeScript, Tailwind | Dev server on `:3000` |

## Getting started

Backend:

```sh
cd backend
go run .
# health check: http://localhost:8080/api/health
```

Frontend:

```sh
cd frontend
npm install   # already done by create-next-app
npm run dev   # http://localhost:3000
```

## API

- `GET /api/health` → `{"status":"ok"}`
