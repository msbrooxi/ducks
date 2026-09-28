# Ducks setup: Step 0 (connection test)

This proves your phone and the kids' phones can talk to a script that reads
and writes your Google Drive, before any real app gets built. About 10
minutes on your laptop, then a couple of minutes each on your iPhone and one
of the kids' phones.

## Part A: create the Apps Script (on your laptop)

1. Go to **script.google.com** and sign in with your normal Google account.
2. Click **New project** (top left).
3. Delete anything in the code editor, then paste in the entire contents of
   this repo's `apps-script/Code.gs` file.
4. Click the **project name** at the top ("Untitled project") and rename it
   `Ducks`.
5. Click the **gear icon** on the left sidebar (Project Settings).
6. Scroll to **Script Properties** and click **Add script property**. Add
   these two rows, using the two key values I gave you in chat (not written
   in this file, since this repo is public):
   - Property: `OWNER_KEY` Value: *(the first key from chat)*
   - Property: `KID_TEST` Value: *(the second key from chat)*
7. Click **Save script properties**.
8. Back in the editor (the `< >` icon on the left), click **Deploy** (top
   right) > **New deployment**.
9. Click the gear next to "Select type" and choose **Web app**.
10. Set:
    - Description: `Ducks test`
    - Execute as: **Me**
    - Who has access: **Anyone**
11. Click **Deploy**.
12. Google will ask you to authorize. Click **Authorize access**, pick your
    account, and you'll likely see a warning screen "Google hasn't verified
    this app." This is normal, it's your own script. Click **Advanced**,
    then **Go to Ducks (unsafe)**, then **Allow**.
13. You'll now see a **Web app URL** that looks like
    `https://script.google.com/macros/s/AKf.../exec`. Copy it somewhere
    safe (a Notes app is fine). You'll paste it into the test pages.

## Part B: turn on GitHub Pages (one time, on the ducks repo)

1. Go to **github.com/msbrooxi/ducks**.
2. Click **Settings** (top of the repo, not your account settings).
3. In the left sidebar, click **Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a
   branch**, **Branch** to **main**, folder **/ (root)**. Click **Save**.
5. Wait about a minute, then refresh the page. It will show a URL like
   `https://msbrooxi.github.io/ducks/`. That's now live for anyone with the
   link, but it holds no data of yours, only page layout and code.

## Part C: test from your iPhone

1. Open Safari and go to `https://msbrooxi.github.io/ducks/test/`
2. Paste the **web app URL** from Part A into the first box.
3. Paste the **first key** from chat (the same one you set as `OWNER_KEY`)
   into "Your owner key".
4. Tap **Save test message**, then **Load test message**. You should see
   your message echoed back with a timestamp.

## Part D: test from a kid's phone (Angelina or Max's Samsung works fine)

1. Open a browser and go to
   `https://msbrooxi.github.io/ducks/test/kid.html`
2. Paste the same **web app URL**.
3. Paste the **second key** from chat (the same one you set as `KID_TEST`)
   into "Kid key".
4. Type something in the message box and tap **Submit**. You should see a
   "Quack! Mom got it" reply.
5. Back on your iPhone's owner test page, tap **Check kid inbox**. You
   should see that submission listed.

## If something fails

- **"Key not recognized"**: double check you copied the whole key with no
  extra spaces, into the right box.
- **A blank page or a script error**: send me exactly what the log box
  says and I'll fix it.
- **Nothing seems to send**: confirm the web app URL ends in `/exec`, not
  `/dev`.

## After this test passes

Tell me it worked (or what broke) and I'll delete this throwaway `test/`
folder and the test script properties, then start building the real Phase 1
app on top of the same Apps Script.
