# NZN Quiz 6.8.21 — Refresh visual da versão 6.8.20

Esta versão preserva a estrutura e o fluxo visual da versão 6.8.20.

## O que mudou

- nova paleta em preto, branco e azul escuro;
- cores atualizadas no painel, login, salas, apresentação, ranking e pódio;
- alternativas do quiz em diferentes tons de azul escuro;
- barra de controle compacta preservada;
- FAQ e suporte interno mantidos;
- notificações de novas mensagens para ADM Master e Instrutor;
- banco PostgreSQL e dados atuais preservados.

## Como atualizar

Substitua no GitHub:

- `server.js`
- `package.json`

Depois, no Render:

1. Abra o serviço.
2. Clique em **Manual Deploy**.
3. Selecione **Clear build cache & deploy**.

## Verificação

Abra `/health` e confirme:

```json
{
  "version": "6.8.21",
  "persistenceMode": "postgres",
  "storeReady": true
}
```
