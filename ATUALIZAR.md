# Atualização NZN Quiz 6.8.6

## O que mudou

1. A Visão geral foi simplificada e agora mostra somente:
   - total de quizzes criados;
   - usuários ativos;
   - usuários inativos.

2. Cada quiz agora possui:
   - Iniciar;
   - Editar;
   - Duplicar;
   - Excluir.

3. A exclusão exige confirmação e é permanente.

4. O campo “Explicação da resposta” foi removido do editor e das telas de resposta.

5. Cada questão começa com três alternativas:
   - alternativas 1 e 2 obrigatórias;
   - alternativa 3 opcional;
   - botão para adicionar novas alternativas;
   - limite de seis alternativas por questão.

6. A logo não foi alterada nesta versão.

## Como publicar

1. No repositório do GitHub, substitua:
   - `server.js`
   - `package.json`

2. Salve as alterações com um commit.

3. No Render, abra o Web Service que está funcionando.

4. Clique em:
   - `Manual Deploy`
   - `Clear build cache & deploy`

5. Aguarde o status `Live`.

6. Abra `/health` no final do endereço do site e confirme:

```json
"version": "6.8.6"
```

## Segurança

A variável `DATABASE_URL` e outras senhas devem permanecer somente no painel Environment do Render. Não publique esses dados no GitHub.
