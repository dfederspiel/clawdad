---
id: progressive-discovery
teaches: "Suggesting new features over time based on usage milestones"
tools: []
complexity: beginner
depends_on: [scheduling, file-persistence]
---

## Progressive Discovery

Don't dump every feature on the user at once. Introduce new capabilities naturally as they use the agent over time.

### Milestone-based suggestions

Track usage in your state files and suggest features at natural moments:

- **After 3 interactions:** Suggest a related feature they haven't tried
- **After 5 interactions:** Introduce a more advanced capability
- **After a week:** Recommend a complementary agent template

### Example pattern

```
After the user has been using the agent for a few sessions:

> "By the way — did you know I can also [new capability]?
>  Just say '[command]' and I'll set it up."
```

### Keep it natural

- Frame suggestions as helpful tips, not feature announcements
- Only suggest features relevant to what the user is already doing
- One suggestion at a time — don't list everything
- If they ignore a suggestion, don't repeat it

### Cross-agent recommendations

After extended use, suggest complementary agents:

> "You might want to try [other template] — it connects to [feature] and could work alongside what we're doing here."

This helps users discover the full platform organically.
