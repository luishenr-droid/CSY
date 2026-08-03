# Atualização NZN Quiz 6.3

Envie para a raiz do repositório GitHub apenas:

- `server.js`
- `package.json`

O arquivo `server.js` já contém toda a interface, inclusive o logo. Depois, no Render, faça **Manual Deploy → Clear build cache & deploy**.

Confirme em `/health` que aparece `version: 6.3.0`.

## Acesso administrativo

O primeiro acesso solicita Nome, Usuário, E-mail e Senha. Depois, o login pode ser feito pelo **Usuário**. Contas antigas ainda podem entrar com o e-mail no campo Usuário. Para salvar contas permanentemente, configure `DATABASE_URL` no Render.
