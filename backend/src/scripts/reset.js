// Development-only: wipes the local JSON database and private file storage, then reseeds.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset in production');
  process.exit(1);
}
const { resetAndSeed } = await import('../services/seed.js');
const { users } = resetAndSeed();
console.log('Database reset with fictional seed data. Logins:');
console.table(users);
