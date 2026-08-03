# NZN Quiz 6.5 — atualização

## Arquivos que devem substituir no GitHub

- `server.js`
- `package.json`

O logo continua incorporado ao `server.js`. O arquivo `logo-nzn.png` foi incluído apenas como cópia de referência.

## Mudanças

- Cadastro público removido.
- Somente o ADM Master cria novas contas.
- O Master informa nome completo, e-mail e tipo de conta.
- O sistema gera usuário e senha temporária automaticamente.
- A pessoa é obrigada a trocar a senha no primeiro acesso.
- A senha pode ser alterada novamente em **Minha conta**.
- Perfis: **ADM Master** e **Instrutor**.
- Painel reorganizado com Visão geral, Quizzes, Usuários e Minha conta.
- Área de usuários com indicadores, filtros, último acesso, status e bloqueio.
- Compatível com contas antigas `owner/admin`, exibidas como Master/Instrutor.

## Atualização no Render

1. Substitua `server.js` e `package.json` no GitHub.
2. Faça o commit.
3. No Render, use **Manual Deploy → Clear build cache & deploy**.
4. Aguarde o status **Live**.
5. Abra `/health` e confirme `"version":"6.5.0"`.

## Variáveis

Continuam necessárias para a conta Master inicial:

- `ADMIN_EMAIL`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

Para salvar usuários e quizzes permanentemente:

- `DATABASE_URL`

As variáveis de confirmação por e-mail não são mais utilizadas:

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `ADMIN_ALLOWED_DOMAIN`

Elas podem ser removidas do Render.
