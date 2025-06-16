BEGIN TRY

BEGIN TRAN;

-- CreateTable
CREATE TABLE [dbo].[Students] (
    [ID] INT NOT NULL,
    [Name] NVARCHAR(100),
    [Age] INT,
    [EnrolledDate] DATE,
    CONSTRAINT [PK__Students__3214EC275285A795] PRIMARY KEY CLUSTERED ([ID])
);

-- CreateTable
CREATE TABLE [dbo].[organizations] (
    [id] INT NOT NULL,
    [name] VARCHAR(255) NOT NULL,
    [github_id] INT,
    [created_at] DATETIME CONSTRAINT [DF__organizat__creat__24B26D99] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME CONSTRAINT [DF__organizat__updat__25A691D2] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PK__organiza__3213E83F1BD023C3] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ__organiza__72E12F1BE2715157] UNIQUE NONCLUSTERED ([name]),
    CONSTRAINT [UQ__organiza__BEE5FF07C3B49B20] UNIQUE NONCLUSTERED ([github_id])
);

-- CreateTable
CREATE TABLE [dbo].[repositories] (
    [id] INT NOT NULL,
    [organization_id] INT NOT NULL,
    [name] VARCHAR(255) NOT NULL,
    [full_name] VARCHAR(512) NOT NULL,
    [github_id] INT,
    [description] TEXT,
    [url] VARCHAR(512) NOT NULL,
    [default_branch] VARCHAR(255) NOT NULL,
    [last_fetched_at] DATETIME,
    [has_package_json] BIT NOT NULL,
    [created_at] DATETIME CONSTRAINT [DF__repositor__creat__2A6B46EF] DEFAULT CURRENT_TIMESTAMP,
    [updated_at] DATETIME CONSTRAINT [DF__repositor__updat__2B5F6B28] DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT [PK__reposito__3213E83F91B45532] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ__reposito__A79AD91F011B18FC] UNIQUE NONCLUSTERED ([full_name]),
    CONSTRAINT [UQ__reposito__BEE5FF07F07558E6] UNIQUE NONCLUSTERED ([github_id])
);

-- AddForeignKey
ALTER TABLE [dbo].[repositories] ADD CONSTRAINT [repositories_organization_id_fkey] FOREIGN KEY ([organization_id]) REFERENCES [dbo].[organizations]([id]) ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT TRAN;

END TRY
BEGIN CATCH

IF @@TRANCOUNT > 0
BEGIN
    ROLLBACK TRAN;
END;
THROW

END CATCH
