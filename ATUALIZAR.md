# Atualização NZN Quiz 6.6

1. Substitua `server.js` e `package.json` na raiz do GitHub.
2. Faça o commit.
3. No Render, use **Manual Deploy > Clear build cache & deploy**.
4. Aguarde o status **Live**.
5. Abra `/health` e confirme `version: 6.6.0`.

## Observação importante

Mantenha `DATABASE_URL` configurada no Render. Sem PostgreSQL, usuários e perguntas de segurança ficam somente na memória e podem ser perdidos quando o serviço reiniciar.
