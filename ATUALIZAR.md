# Atualização NZN Quiz 6.8.9

## O que mudou

- o menu do perfil agora aparece ao passar o mouse sobre a caixa do usuário;
- o dropdown fica acima da navegação e não é mais coberto;
- a opção **Minha conta** e **Sair** continuam dentro do menu do perfil.

## Como atualizar

Substitua no GitHub:

- server.js
- package.json

Depois, no Render:

1. abra o serviço
2. clique em **Manual Deploy**
3. clique em **Clear build cache & deploy**

## Confirmação

Abra /health e confira: `"version": "6.8.9"`
