# NZN Quiz 6.8.38

Backup completo e organizado do NZN Quiz, pronto para iniciar um repositorio GitHub novo e publicar no Render.

## Versao recuperada

- Versao: `6.8.38`
- Runtime: Node.js 20 ou superior
- Entrada da aplicacao: `server.js`
- Persistencia: PostgreSQL ou modo temporario em memoria
- Endpoint de verificacao: `/health`

A versao 6.8.38 preserva a correcao de login da 6.8.37 e corrige o PagBank em sandbox: normalizacao do token, webhook adaptativo e mensagens de erro detalhadas.

## Conteudo do repositorio

- `server.js`: aplicacao completa.
- `package.json` e `package-lock.json`: dependencias e comandos.
- `render.yaml`: criacao do servico e do PostgreSQL no Render.
- `.env.example`: modelo das variaveis, sem credenciais reais.
- `INSTRUCOES_GITHUB.md`: passo a passo para criar o repositorio do zero.
- `PAGBANK.md`: configuracao e teste de Pix e boleto.
- `HISTORICO-6.8.37.md` e `HISTORICO-6.8.38.md`: historico das correcoes.

## Executar no computador

Requisitos:

- Node.js 20 ou superior;
- npm;
- PostgreSQL, caso queira manter os dados depois que o servidor for reiniciado.

Instale e inicie:

```bash
npm ci
npm start
```

Abra `http://localhost:3000`. Sem `DATABASE_URL`, o sistema inicia em modo temporario e perde os dados quando o processo e reiniciado.

O arquivo `.env.example` serve como referencia. Esta versao nao carrega um arquivo `.env` automaticamente; defina as variaveis no sistema operacional ou diretamente no painel do Render.

## Variaveis principais

| Variavel | Uso | Obrigatoria em producao |
| --- | --- | --- |
| `DATABASE_URL` | Conexao PostgreSQL | Recomendada para preservar dados |
| `ADMIN_EMAIL` | E-mail do primeiro ADM Master | Sim, na primeira instalacao |
| `ADMIN_USERNAME` | Usuario do primeiro ADM Master | Sim, na primeira instalacao |
| `ADMIN_PASSWORD` | Senha inicial do primeiro ADM Master | Sim, na primeira instalacao |
| `PASSWORD_VAULT_SECRET` | Protege senhas temporarias armazenadas | Sim; o Blueprint gera automaticamente |
| `RESEND_API_KEY` | Envio de confirmacao e recuperacao | Somente se usar e-mail |
| `EMAIL_FROM` | Remetente autorizado no Resend | Somente se usar e-mail |
| `ADMIN_ALLOWED_DOMAIN` | Restringe cadastro a um dominio | Nao |
| `PAGBANK_TOKEN` | Habilita Pix e boleto | Somente se usar PagBank |
| `PAGBANK_ENV` | `sandbox` ou `production` | Somente se usar PagBank |
| `PAGBANK_WEBHOOK_VERIFICATION` | `auto`, `required`, `optional` ou `disabled` | Use `auto` |
| `PUBLIC_URL` | URL publica da aplicacao | Nao; o sistema detecta pela requisicao |

Nunca envie senhas, tokens ou o arquivo `.env` ao GitHub.

## Publicar no Render

O caminho mais simples e usar o `render.yaml`:

1. Publique estes arquivos em um repositorio GitHub.
2. No Render, escolha **New > Blueprint**.
3. Conecte o repositorio.
4. Informe `ADMIN_EMAIL`, `ADMIN_USERNAME` e `ADMIN_PASSWORD` quando solicitado.
5. Confirme a criacao do servico e do banco PostgreSQL.
6. Aguarde o deploy e abra `https://SEU-ENDERECO.onrender.com/health`.

A resposta deve indicar a versao `6.8.38`, o modo `postgres` e o PagBank em `sandbox`.

A integracao Resend e opcional. O Blueprint solicita o token PagBank e inicia no ambiente sandbox; consulte `PAGBANK.md` antes do primeiro teste.

## Importante sobre o banco de dados

Este pacote recupera todo o codigo da aplicacao, mas nao contem registros de um banco PostgreSQL antigo. Ao criar um banco novo, o sistema monta as tabelas automaticamente e inicia com o quiz de demonstracao.

Se existir um banco anterior, exporte-o separadamente antes de encerrar o servico antigo.

## Documentacao oficial

- [Criar um repositorio no GitHub](https://docs.github.com/pt/repositories/creating-and-managing-repositories/creating-a-new-repository)
- [Render Blueprints](https://render.com/docs/infrastructure-as-code)
- [Variaveis de ambiente no Render](https://render.com/docs/configure-environment-variables)
- [Checkout PagBank](https://developer.pagbank.com.br/docs/checkout)
