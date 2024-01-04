import express from "express";
import pug from "pug";
import { Command } from "commander";
import { SublinksClient } from "sublinks-js-client";
import sqlite3 from "sqlite3";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { join } from "path";

const app = express();
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
const program = new Command();
const db = new sqlite3.Database("db.sqlite");
const __dirname = new URL(".", import.meta.url).pathname.slice(1);
GlobalFonts.registerFromPath(
  join(__dirname, "public", "fonts", "Inter.ttf"),
  "sans-serif"
);

db.serialize(() => {
  // create table, primary key username
  db.run(
    "CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, posts INTEGER, comments INTEGER)"
  );
});

// ---

app.get("/", (_, res) => {
  res.send(pug.renderFile("views/index.pug"));
});

app.post("/", (req, res) => {
  res.redirect(`/recap/${req.body.user}@${req.body.site}`);
});

app.get("/recap/:input", async (req, res) => {
  try {
    const input = req.params.input;
    if (!input.includes("@")) throw new Error("invalid input");
    const [name, site] = input.split("@");
    const client = new SublinksClient(site.trim());
    const user = await client.getPersonDetails({
      username: name.trim(),
      sort: "TopAll",
      limit: 50,
    });

    const user2 = await client.getPersonDetails({
      username: name.trim(),
      sort: "TopAll",
      limit: 50,
      page: 2,
    });

    // insert into users. if already exists, update
    db.run(
      "INSERT INTO users VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET posts = ?, comments = ?",
      [
        input,
        user.person_view.counts.post_count,
        user.person_view.counts.comment_count,
        user.person_view.counts.post_count,
        user.person_view.counts.comment_count,
      ]
    );

    const posts = user.person_view.counts.post_count;
    const comments = user.person_view.counts.comment_count;
    const post_coms = [...user.posts, ...user2.posts].map(
      (post) => post.community
    );
    const comment_coms = [...user.comments, ...user2.comments].map(
      (comment) => comment.community
    );

    const coms = {};

    for (const com of [...post_coms, ...comment_coms]) {
      if (com.actor_id in coms) {
        coms[com.actor_id].count += 1;
      } else {
        coms[com.actor_id] = {
          data: com,
          count: 1,
        };
      }
    }

    const post_communities = new Set(post_coms.map((com) => com.id)).size;
    const comment_communities = new Set(comment_coms.map((com) => com.id)).size;

    const post_sts = user.posts.map((post) => post.community.instance_id);
    const comment_sts = user.comments.map(
      (comment) => comment.community.instance_id
    );

    const sts = {};

    for (const st of [...post_sts, ...comment_sts]) {
      if (st in sts) {
        sts[st].count += 1;
      } else {
        sts[st] = {
          data: st,
          count: 1,
        };
      }
    }

    const post_sites = new Set(post_sts).size;
    const comment_sites = new Set(comment_sts).size;

    const communities = Object.entries(coms)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([_, com]) => com);

    const sites = Object.entries(sts)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([_, com]) => com);

    // RANK

    // get index of user sorted by posts from the db
    const rank = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM users ORDER BY posts DESC", (err, rows) => {
        if (err) reject(err);
        else resolve(rows.findIndex((user) => user.username === input) + 1);
      });
    });

    // get index of user sorted by comments from the db
    const rank2 = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM users ORDER BY comments DESC", (err, rows) => {
        if (err) reject(err);
        else resolve(rows.findIndex((user) => user.username === input) + 1);
      });
    });

    // get total number of users from the db
    const total = await new Promise((resolve, reject) => {
      db.get("SELECT COUNT(*) AS count FROM users", (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });

    let role = "";
    let role_description = "";
    // lurker - no posts or comments
    if (posts === 0 && comments === 0) {
      role = "lurker";
      role_description = "You haven't posted or commented yet";
    }
    // rookie - account age < 1 month
    else if (
      new Date(user.person_view.person.published).getTime() >
      Date.now() - 2592000000
    ) {
      role = "rookie";
      role_description =
        "You are new to lemmy! You joined less than a month ago";
    }
    // scholar - more comments than posts
    else if (comments > posts) {
      role = "scholar";
      role_description = "You comment more than you post";
    }
    // scribe - more posts than comments
    else if (posts >= comments) {
      role = "scribe";
      role_description = "You post more than you comment";
    }

    // alchemist - top posts mostly have around the same amount of comments and score
    const val = user.posts
      .map((post) => post.counts.comments / post.counts.score)
      .reduce((acc, val) => acc + (val > 0.33 && val < 0.67 ? 1 : 0), 0);

    if (val / user.posts.length >= 0.65) {
      role = "alchemist";
      role_description =
        "You posts usually have the same amount of comments and score";
    }

    // blacksmith
    // top posts have high comment amounts relative to score
    const val2 = user.posts
      .map((post) => (post.counts.comments / post.counts.score) * 5)
      .reduce((acc, val) => acc + (val >= 0.67 ? 1 : 0), 0);

    if (val2 / user.posts.length >= 0.65) {
      role = "blacksmith";
      role_description = "Your posts usually have a lot of comments";
    }

    // artisan
    // top posts have low comment amounts relative to score
    const val3 = user.posts
      .map((post) => (post.counts.comments / post.counts.score) * 5)
      .reduce((acc, val) => acc + (val <= 0.33 ? 1 : 0), 0);

    if (val3 / user.posts.length >= 0.65) {
      role = "artisan";
      role_description =
        "Your posts usually have a lot of score relative to comments";
    }

    // wizard - in the top 10% of commenters
    if (rank2 <= total * 0.1) {
      role = "wizard";
      role_description = "You are in the top 10% of commenters";
    }
    // vanguard - in the top 10% of posters
    if (rank <= total * 0.1) {
      role = "vanguard";
      role_description = "You are in the top 10% of posters";
    }

    // exporer - top posts and comments include 40 different communities
    if (communities.length >= 40) {
      role = "explorer";
      role_description =
        "Your top 100 posts and comments include 40 different communities";
    }

    // adventurer - top posts and comments include 9 different sites
    if (sites.length >= 9) {
      role = "adventurer";
      role_description =
        "Your top 100 posts and comments include 9 different sites";
    }

    // sage - top 0.1%
    if (rank2 <= total * 0.01) {
      role = "sage";
      role_description = "You are in the top 1% of commenters";
    }

    // chamption - top 0.1%
    if (rank <= total * 0.01) {
      role = "champion";
      role_description = "You are in the top 1% of posters";
    }

    // legend - top 0.01% of posts or comments
    if (rank <= total * 0.001 || rank2 <= total * 0.001) {
      role = "legend";
      role_description = "You are in the top 0.1% of posters or commenters";
    }

    const canvas = createCanvas(640, 360);
    const ctx = canvas.getContext("2d");
    // choose one of the backgrounds
    const backgrounds = [
      "public/images/forest.jpg",
      "public/images/sunset.jpg",
      "public/images/ottawa.jpg",
      "public/images/secret.jpg",
      "public/images/church.jpg",
      "public/images/forest2.jpg",
      "public/images/aurora.jpg",
      "public/images/thunderstorm.jpg",
    ];
    const bg = await loadImage(backgrounds[Math.floor(Math.random() * 5)]);
    ctx.drawImage(bg, 0, 0, 640, 360);

    // Black square with rounded corners around top stats
    ctx.fillStyle = "black";
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.roundRect(10, 10, 620, 130, 10);
    ctx.fill();
    ctx.globalAlpha = 1;

    // another one for bottom left side
    ctx.fillStyle = "black";
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.roundRect(10, 150, 340, 200, 10);
    ctx.fill();
    ctx.globalAlpha = 1;

    // another one for bottom right side
    ctx.fillStyle = "black";
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.roundRect(360, 150, 270, 200, 10);
    ctx.fill();
    ctx.globalAlpha = 1;

    // AVATAR
    if (user.person_view.person.avatar) {
      ctx.save();
      const img = await loadImage(user.person_view.person.avatar);
      ctx.beginPath();
      ctx.arc(65, 75, 45, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 20, 30, 90, 90);
      ctx.restore();
    }

    // DISPLAY NAME

    // get instance from user's ap_id
    const [_, __, instance] = user.person_view.person.actor_id.split("/");

    let message_from_admins = "";

    if (instance == "programming.dev") {
      message_from_admins =
        "Thanks for being a part of the instance for the past year! ❤️ We have some new things getting made that should be releasing this year such as a better status page and a team page, as well as things like programming challenges and events with people from all instances";
    }

    ctx.font = "bold 30px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText(
      user.person_view.person.display_name || user.person_view.person.name,
      122,
      62
    );
    ctx.fillStyle = "#61ff91";
    ctx.fillText(
      user.person_view.person.display_name || user.person_view.person.name,
      120,
      60
    );

    // right align instance
    ctx.textAlign = "right";
    ctx.font = "20px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText(instance, 610, 62);
    ctx.fillStyle = "#ff6191";
    ctx.fillText(instance, 608, 60);

    ctx.textAlign = "left";

    // POSTS AND COMMENTS
    ctx.font = "20px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText(`${posts} posts`, 122, 92);
    ctx.fillText(`${comments} comments`, 122, 118);
    ctx.fillStyle = "#a1a1a1";
    ctx.fillText(`${posts} posts`, 120, 90);
    ctx.fillText(`${comments} comments`, 120, 116);

    // communities, sites, rank. in between posts and comments and recap text
    ctx.font = "20px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText(`${communities.length} communities`, 280, 92);
    ctx.fillText(`${sites.length} sites`, 280, 118);
    ctx.fillStyle = "#a1a1a1";
    ctx.fillText(`${communities.length} communities`, 278, 90);
    ctx.fillText(`${sites.length} sites`, 278, 116);

    // PANGORA RECAP TEXT (on right) rotated a bit
    ctx.save();
    ctx.translate(610, 90);
    //ctx.rotate((Math.PI / 180) * 5);
    // right align text
    ctx.textAlign = "right";
    ctx.font = "15px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText("recap.pangora.social", 0, 28);
    ctx.fillStyle = "#515151";
    ctx.fillText("recap.pangora.social", -2, 26);
    // 2023
    ctx.font = "15px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText("2023", 0, 0);
    ctx.fillStyle = "#515151";
    ctx.fillText("2023", -2, -2);
    ctx.restore();

    ctx.textAlign = "left";

    // Top 5 communities (bottom left side)
    ctx.font = "bold 20px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText("Top 5 communities", 20, 185);
    ctx.fillStyle = "#51cc71";
    ctx.fillText("Top 5 communities", 18, 183);

    // icons (com.data.icon)
    for (let i = 0; i < 5; i++) {
      if (communities[i]) {
        if (communities[i].data.icon) {
          try {
            const img = await loadImage(communities[i].data.icon);
            ctx.drawImage(img, 20, 200 + i * 30, 20, 20);
          } catch (e) {}
        }

        // extract community name and instance from ap_id (https://instance/c/community)
        const [_, __, instance, ___, name] =
          communities[i].data.actor_id.split("/");

        ctx.font = "15px sans-serif";
        ctx.fillStyle = "black";
        ctx.fillText(name, 50, 217 + i * 30);
        ctx.fillStyle = "#61ff91";
        ctx.fillText(name, 48, 215 + i * 30);

        // instances
        ctx.font = "15px sans-serif";
        ctx.fillStyle = "black";
        ctx.fillText(instance, 200, 217 + i * 30);
        ctx.fillStyle = "#ff6191";
        ctx.fillText(instance, 198, 215 + i * 30);
      }
    }

    // right align and show role
    ctx.textAlign = "right";
    ctx.font = "bold 20px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText("Role", 620, 185);
    ctx.fillStyle = "#51cc71";
    ctx.fillText("Role", 618, 183);

    ctx.font = "20px sans-serif";
    ctx.fillStyle = "black";
    ctx.fillText(role, 620, 230);
    ctx.fillStyle = "#ff6191";
    ctx.fillText(role, 618, 228);

    // wrap role description if line is too long
    ctx.font = "15px sans-serif";
    ctx.fillStyle = "#c1c1c1";
    const words = role_description.split(" ");
    let line = "";
    let y = 260;
    for (const word of words) {
      const testLine = line + word + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > 250) {
        ctx.fillStyle = "black";
        ctx.fillText(line, 620, y);
        ctx.fillStyle = "#c1c1c1";
        ctx.fillText(line, 618, y - 2);
        line = word + " ";
        y += 30;
      } else {
        line = testLine;
      }
    }
    ctx.fillStyle = "black";
    ctx.fillText(line, 620, y);
    ctx.fillStyle = "#c1c1c1";
    ctx.fillText(line, 618, y - 2);

    const buffer = canvas.toBuffer("image/png");

    res.send(
      pug.renderFile("views/recap.pug", {
        name,
        post_communities,
        comment_communities,
        posts: posts,
        comments: comments,
        top_posts: user.posts.slice(0, 5),
        top_comments: user.comments.slice(0, 5),
        post_sites,
        comment_sites,
        communities: communities.slice(0, 5),
        sites: sites.slice(0, 5),
        total_communities: communities.length,
        final_card: "data:image/png;base64," + buffer.toString("base64"),
        role,
        role_description,
        message_from_admins,
      })
    );
  } catch (err) {
    res.send(pug.renderFile("views/error-find.pug"));
  }
});

// CLI
program.option("-p, --port [number]", "specify a port to use", 3000);

program.parse(process.argv);
const options = program.opts();

// -

app.listen(options.port, () => {
  console.log(`Server running on port ${options.port}`);
});
