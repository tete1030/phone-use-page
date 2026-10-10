try {
  const response=await fetch('http://127.0.0.1:'+(process.env.PORT||8780)+'/health',{signal:AbortSignal.timeout(3500)});
  if(!response.ok||(await response.json()).ok!==true)process.exit(1);
} catch { process.exit(1); }
