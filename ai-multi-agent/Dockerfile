FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "fastapi>=0.110" "uvicorn[standard]>=0.29" \
    "celery>=5.3" "redis>=5.0" "httpx>=0.27" "pydantic>=2.6"
COPY shared ./shared
COPY agents ./agents
COPY orchestrator ./orchestrator
# Default: run the orchestrator API. Workers override CMD in docker-compose.
EXPOSE 8001
CMD ["uvicorn", "orchestrator.app:app", "--host", "0.0.0.0", "--port", "8001"]
