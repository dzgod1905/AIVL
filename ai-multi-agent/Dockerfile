FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "fastapi>=0.110" "uvicorn[standard]>=0.29" \
    "celery>=5.3" "redis>=5.0" "httpx>=0.27" "pydantic>=2.6" \
    "openpyxl>=3.1" "psycopg[binary]>=3.1" "psycopg-pool>=3.2"
COPY shared ./shared
COPY node ./node
COPY orchestrator ./orchestrator
COPY worker.sh ./worker.sh
# Default: run the orchestrator API. Workers override CMD in docker-compose.
EXPOSE 8001
CMD ["uvicorn", "orchestrator.app:app", "--host", "0.0.0.0", "--port", "8001"]
