Commands:
node --env-file=.env createJobs.js --folder=all --command=all
node --env-file=.env createJobs.js --folder=all --command=all --input=i1 --prompt=i1.txt;
node .\processQueue.js; 
node .\processQueue.js --service=mukeai
node --env-file=.env .\compress.js

Full processs:
node --env-file=.env createJobs.js --folder=all --command=all; node .\processQueue.js; node .\processQueue.js --service=mukeai
node --env-file=.env createJobs.js --folder=all --command=all --input=i1 --prompt=i1.txt; node .\processQueue.js; node .\processQueue.js --service=mukeai

Syncing:
(For compressed folder, only sync new files, no deletion, for other stuff, accept all changes - 1st command sync all new files, 2st command sync all changes except for ./compressed):
robocopy "D:\Node\compressed" "E:\Node\compressed" /E /XO
robocopy "D:\Node" "E:\Node" /MIR /XD "D:\Node\compressed"

(Move new files to E:\node): robocopy "D:\node" "E:\node" /E /R:3 /W:5
(Full write, delete files in E:\node, don't use it unless D:\node contains all files): robocopy "D:\node" "E:\node" /MIR /R:3 /W:5

Sorting:
node .\sort.js
(Shows numbered folders and prompts. Enter pairs with spaces or commas, for example: 10:17 10:18 10:19)
node .\sort.js --pairs="10:17,10:18,10:19"
node .\sort.js --pairs="10:*,*:3,1->2:3,3:19->50"
node .\sort.js --input=./compressed --output=./sort --prompt=./prompt.txt