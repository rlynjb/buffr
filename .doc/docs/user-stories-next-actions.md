---
title: user_stories-next_actions
category: docs
---
Contains detailed prompts to polish existing features in buffr.
- Complex or branching logic
- Specific structure needed
- Fitting into an existing codebase
- AI has guessed wrong before

## Data model


## Behaviour
project page > Next Actions tab > user can add a task:
- user types in “Add a tasks” field
- user clicks add button
- click triggers “add” endpoint call
- once endpoint call returns response data
- task gets added in todo list
- task is added as 1st item

project page > Next Actions tab > user can edit a task:
- user click on a task text
- inline editing is enabled
- debounce typing every 20seconds
- data should auto save
- call “update” endpoint
- notify user data is saved by highlight field with dimmed green border
- dimmed green border should fade to disappear for 5sec

project page > Next Actions tab > user can delete a task:
- user clicks on delete icon
- call “delete” endpoint
- notify user task is deleted by
- a pop up toast in top right corner of page

project page > Next Actions tab > user can complete a task:
- user clicks checkbox field (toggle)
- task is crossed out. Set to done
- user clicks true checkbox field (toggle)
- task is not crossed out. Set to undone

project page > Next Actions tab:
- user can reorder tasks

project page > Next Actions tab:
- user can rewrite a task

project page > Next Actions tab:
- user can rewrite a task based on personas