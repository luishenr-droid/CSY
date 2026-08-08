# Atualização pontual PagBank — NZN Quiz 6.8.39

Esta correção deve ser aplicada sobre a versão 6.8.38.

## Arquivo para substituir no GitHub

Substitua somente:

- `server.js`

O arquivo `ATUALIZAR.md` é apenas este manual e não precisa ser enviado ao GitHub.

## O que foi corrigido

O Checkout PagBank enviava `redirect_waiting_time: 3`, mas a API aceita valores entre 5 e 120 segundos. A versão 6.8.39 envia 15 segundos.

## Como publicar

1. Abra o repositório no GitHub.
2. Entre no arquivo `server.js`.
3. Use a opção para substituir ou enviar a nova versão do arquivo.
4. Confirme em **Commit changes**.
5. Aguarde o deploy automático no Render ou use **Manual Deploy > Deploy latest commit**.
6. Abra `/health` e confirme a versão `6.8.39`.
7. Teste novamente o Pix com valor mínimo de R$ 2,00.

Não é necessário alterar as variáveis do PagBank novamente se o token Sandbox já foi aceito.
