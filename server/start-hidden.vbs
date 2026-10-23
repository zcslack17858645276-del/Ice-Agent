Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\codex\desktop-agent"
sh.Run """D:\nodejs\node.exe"" ""D:\codex\desktop-agent\server\server.mjs""", 0, False
