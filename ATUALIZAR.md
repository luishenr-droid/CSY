# NZN Quiz 6.8.24

Atualização baseada diretamente na versão 6.8.23.

## Alterações

1. Resultados
   - removido o botão Excel da lista de resultados;
   - o botão Baixar Excel permanece dentro da página do resultado;
   - início e finalização foram substituídos por uma única informação de data e horário do quiz;
   - duração, participantes, questões, gráficos e lista de participantes permanecem no dashboard.

2. Usuários
   - removidas da lista as colunas Último acesso e Prazos;
   - essas informações continuam disponíveis dentro do perfil;
   - adicionada opção Excluir perfil somente para ADM Master;
   - não é permitido excluir a própria conta conectada;
   - o sistema protege o último ADM Master ativo.

3. Quizzes
   - nova lista horizontal mais simples e organizada;
   - mostra título, descrição, quantidade de questões, criador e atualização;
   - mantém Iniciar, Editar, Duplicar e Excluir;
   - editor e funcionamento dos quizzes não foram alterados.

## Atualização no Render

Substitua `server.js` e `package.json` no GitHub e faça:

Manual Deploy → Clear build cache & deploy

Depois confirme `/health` com a versão `6.8.24`.
