# NZN Quiz 6.8.37 — Hotfix de login

Correção pontual sobre a versão 6.8.36.

## Corrigido

- Corrigida a chamada do contador de notificações de suporte que causava `TypeError: store.getSupportUnreadCount is not a function` após o login.
- A função correta `supportUnreadCount()` já existia no DataStore; o endpoint estava chamando o nome errado.
- Nenhuma funcionalidade da 6.8.36 foi removida ou redesenhada.

## Atualização

Substitua no GitHub:

- `server.js`
- `package.json`

Depois no Render: **Manual Deploy → Clear build cache & deploy**.

Confirme em `/health` que a versão é `6.8.37`.
