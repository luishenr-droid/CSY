# NZN Quiz 6.8.21 — FAQ e Suporte

Esta versão foi construída diretamente sobre os arquivos 6.8.20 enviados pelo usuário.

## Novidades

- menu **FAQ & Suporte** dentro da navegação já existente;
- sino de notificações no topo, ao lado do perfil;
- atalho para FAQ/suporte dentro do menu do usuário;
- instrutores podem enviar dúvidas, sugestões e problemas;
- instrutores acompanham apenas as próprias solicitações;
- ADM Masters recebem notificações e acessam a caixa de suporte;
- ADM Masters respondem mensagens e alteram o status do chamado;
- FAQ visível para todos e editável somente pelos ADM Masters;
- atualização automática do contador de notificações a cada 20 segundos.

## Banco de dados

As tabelas abaixo são criadas automaticamente no PostgreSQL:

- `faq_entries`
- `support_tickets`
- `support_messages`

Os quizzes, usuários e resultados existentes não são apagados.

## Atualização

Substitua no GitHub:

- `server.js`
- `package.json`

No Render, use:

**Manual Deploy → Clear build cache & deploy**

Depois, confirme em `/health`:

```json
{
  "version": "6.8.21",
  "persistenceMode": "postgres",
  "storeReady": true
}
```
