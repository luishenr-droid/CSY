# NZN Quiz 6.9.0

Esta versão inclui:

- redesign completo do painel administrativo;
- navegação lateral moderna e responsiva;
- Central de Ajuda com FAQ;
- criação e edição de FAQ pelo ADM Master;
- chamados de dúvida, sugestão e problema;
- respostas dentro da plataforma;
- status Novo, Em análise, Respondido e Encerrado;
- notificações para ADM Masters e para instrutores quando houver resposta;
- persistência completa no PostgreSQL configurado em `DATABASE_URL`.

## Atualização

Substitua no GitHub:

- `server.js`
- `package.json`

Depois, no Render, use **Manual Deploy → Clear build cache & deploy**.

## Confirmação

Acesse `/health` e confirme:

```json
"version": "6.9.0",
"persistenceMode": "postgres",
"storeReady": true
```

As novas tabelas de FAQ e suporte são criadas automaticamente no primeiro deploy.
