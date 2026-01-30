# TwentyQ

A cloud-hosted AI-powered “20 Questions” game built on Microsoft Azure.

## Tech Stack
- Azure Static Web Apps (frontend hosting)
- Azure Functions (serverless API)
- Azure AI / OpenAI (LLM gameplay engine)
- Azure Storage (session state & highscores)
- Azure Key Vault (secrets management)
- GitHub Actions (CI/CD)

## Features
- Text-based 20 Questions gameplay
- Server-side AI decision making
- Persistent game sessions
- Global leaderboard

## Architecture
Frontend → Azure Functions API → Azure AI  
State & scores stored in Azure Storage

## Status
In active development
