# Manual test checklist

After installing the zips, check these 6 items. Each takes about a minute.

1. **Tall page** - Open a 20,000px tall article, set browser zoom to 200%
   (simulates DPR 2), take a Full Page screenshot. **Pass:** the file is
   created.
2. **Shortcuts** - On a normal page press Ctrl+Shift+S, Ctrl+Shift+X,
   Ctrl+Shift+E, Alt+Shift+E. **Pass:** the same action as the buttons.
3. **Rebind** - Change one shortcut at `chrome://extensions/shortcuts` and
   press it again. **Pass:** the new key works.
4. **Ask for filename** - Turn on "Ask for filename" in Settings, download
   an image, rename it in the dialog. **Pass:** saved under the new name.
5. **Show in folder** - From History, use "Show in folder" on a download.
   **Pass:** the folder opens.
6. **ZIP cancel** - Start a 200-image ZIP, press Cancel in the popup.
   **Pass:** no zip file is created and memory drops back.
7. **Google Lens** - Right-click an image, choose Search Image with Google
   Lens. **Pass:** the Google Lens results page opens for that image, in
   both Chrome and Edge.

If anything fails, report which item and the exact error message.
