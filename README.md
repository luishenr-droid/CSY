# Quiz Credsystem — versão 6

Plataforma de quiz corporativo ao vivo, inspirada na identidade visual atual da Credsystem, com limite de 100 participantes por sala.

## Novidades

- Interface em preto/cinza com gradiente ciano, azul, violeta e magenta.
- Tela do apresentador controlada pelo administrador.
- Criação, edição e armazenamento de quizzes.
- Alternativas vazias são removidas automaticamente.
- 16 avatares customizados.
- Música gerada pelo navegador, com três temas e opção sem música.
- Música de suspense e animação antes do ranking.
- Novo link, código e QR Code criados após o encerramento.
- Cadastro de novos administradores dentro do painel.
- Relatório Excel com data, horário, presença e respostas individuais.
- Limite de 100 participantes por sala.
- PostgreSQL opcional para persistência.

## Arquivos necessários no GitHub

- `server.js`
- `package.json`

O arquivo `server.js` contém toda a interface incorporada. A pasta `public` não é necessária para o Render.

## Render

- Serviço: Web Service
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check: `/health`

## Variáveis de ambiente

- `ADMIN_EMAIL`: administrador principal inicial.
- `ADMIN_PASSWORD`: senha inicial.
- `DATABASE_URL`: conexão PostgreSQL opcional, recomendada para salvar os dados.
- `NODE_ENV`: `production`.

Sem `DATABASE_URL`, a aplicação funciona em modo temporário.
