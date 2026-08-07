# Configuração PagBank — NZN 6.8.33

1. Comece com o token de Sandbox do PagBank.
2. No Render, crie `PAGBANK_TOKEN` e `PAGBANK_ENV=sandbox`.
3. Faça um novo deploy.
4. Abra **Apoie o NZN**, gere uma transação e conclua pelo ambiente PagBank.
5. O NZN envia `notification_urls` e `payment_notification_urls` automaticamente para `/api/pagbank/webhook`.
6. O webhook valida `x-authenticity-token` usando SHA-256 de `{token}-{payload bruto}` antes de atualizar a transação.
7. Após os testes e a homologação exigida pelo PagBank, use o token de produção e `PAGBANK_ENV=production`.

Nunca envie o token do PagBank para o GitHub ou para conversas.
