# TV de Tubo

Protótipo que reúne lives brasileiras no ar no YouTube, na Twitch e na Kick e funciona como uma TV aberta: troque de canal, zapeie e filtre por plataforma, tema, tamanho do canal e ordem.

- Site: https://eduardomontsm.github.io/tv-de-lives/
- Coleta: `.github/workflows/scan.yml` + `scripts/scan.mjs` (GitHub Actions), publica `lives.json` e `catalog.json` no branch `data`.
- O site é estático e só lê esses arquivos; não tem chave nem login.
