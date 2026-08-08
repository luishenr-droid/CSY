# Atualização pontual — NZN Quiz 6.9.0

Use este pacote somente sobre uma instalação 6.8.41 que já esteja funcionando.

## O que subir no GitHub

Suba apenas:

```text
server.js
```

O arquivo `ATUALIZAR.md` é apenas este manual e não precisa ser enviado.

## Passo a passo

1. Antes de alterar o GitHub, baixe uma cópia do `server.js` atual.
2. Abra o repositório usado pelo Render.
3. Substitua o `server.js` antigo pelo arquivo deste pacote.
4. Faça o commit com uma mensagem como `Atualizar NZN Quiz para 6.9.0`.
5. Aguarde o Render publicar o novo commit.
6. Abra `https://SEU-ENDERECO.onrender.com/health` e confirme `"version":"6.9.0"`.

## Não precisa alterar

- `package.json` ou `package-lock.json` na atualização pontual;
- banco PostgreSQL;
- `render.yaml`;
- variáveis do Mercado Pago, PagBank ou Resend;
- credenciais administrativas.

## Conferência depois do deploy

1. Abra `/painel/quizzes` diretamente.
2. Abra o endereço antigo `/?admin=1` e confirme que ele muda para `/painel`.
3. Crie uma sala e confira os novos links `/sala/CODIGO` e `/tela/CODIGO`.
4. Teste um Pix Mercado Pago e confirme que o QR Code aparece dentro da plataforma.
5. Se usa boleto, confirme que o checkout PagBank ainda abre.
6. Confira o layout no computador e no celular.

Se o navegador ainda mostrar o visual antigo, atualize a página com `Ctrl + F5` no Windows ou `Cmd + Shift + R` no Mac.

## Voltar para a versão anterior

Se houver algum problema, recoloque o `server.js` 6.8.41 que você salvou no passo 1 e faça um novo commit. O banco e as variáveis permanecem compatíveis.
