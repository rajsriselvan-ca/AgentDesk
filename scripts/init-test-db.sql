-- Runs once, on first initialisation of the Postgres volume.
-- The test suite needs its own database; see TEST_DATABASE_URL in .env.example.
CREATE DATABASE agentdesk_test OWNER postgres;
