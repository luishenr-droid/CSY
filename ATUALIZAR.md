# NZN Quiz 6.8.31

Base: NZN 6.8.30.

## Alterações

- removida a opção de tema claro/escuro; o NZN volta a usar somente o tema claro;
- removidos os pequenos rótulos indicados pelas linhas vermelhas no PDF;
- removidos os atalhos "Ir para suporte" e "Abrir FAQ" das páginas de FAQ e Suporte;
- a notificação deixou de aparecer na foto de perfil e no menu superior;
- novas mensagens aparecem como uma bolinha vermelha no módulo Suporte da tela inicial;
- criação de usuário e lista de usuários foram separadas;
- novo módulo "Criar usuário" aparece na tela inicial somente para ADM Master;
- o módulo "Usuários" agora mostra apenas indicadores, filtros e a lista de perfis.

## Atualização

Substitua no GitHub:

- `server.js`
- `package.json`

No Render:

**Manual Deploy -> Clear build cache & deploy**

Depois confira `/health`. A versão deve ser `6.8.31`.
