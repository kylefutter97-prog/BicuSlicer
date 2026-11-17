# Runs at the start of every Python process in the BicuSlicer Windows app (the launcher, the server and its helper
# scripts). Python normally checks HTTPS certificates against a fixed list it reads from Windows at start-up, which
# misses root certificates Windows only fetches when first needed, and company HTTPS inspection. truststore makes
# Python ask Windows itself, as browsers do, so downloads (OrcaSlicer, its printer library) work wherever Edge does.
try:
    import truststore

    truststore.inject_into_ssl()
except Exception:          # never stop the app starting over this
    pass
