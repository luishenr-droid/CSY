# Atualização NZN Quiz 6.8.10

## Correção

- o menu do perfil continua abrindo ao passar o mouse;
- ao clicar em **Minha conta**, o menu fecha automaticamente;
- o menu não permanece mais fixo enquanto a página de perfil estiver aberta.

## Como atualizar

Substitua no GitHub:

- server.js
- package.json

Depois, no Render:

1. abra o serviço que está funcionando;
2. clique em **Manual Deploy**;
3. selecione **Clear build cache & deploy**.

Confirme em /health:

```json
"version": "6.8.10"
```
